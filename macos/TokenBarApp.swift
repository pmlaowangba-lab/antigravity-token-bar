import AppKit
import CoreGraphics
import Foundation
import WebKit

final class FloatingBarPanel: NSPanel {
  var allowKey: Bool = false
  override var canBecomeKey: Bool { allowKey }
  override var canBecomeMain: Bool { false }
}

@MainActor
final class WebBridge: NSObject, WKScriptMessageHandler {
  weak var owner: AppController?
  var windowId: CGWindowID = 0

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any] else { return }
    switch message.name {
    case "agPanelState":
      let open = (body["open"] as? Bool) ?? false
      owner?.setExpanded(open, for: windowId)
    case "agDrag":
      let dx = (body["dx"] as? NSNumber)?.doubleValue ?? 0
      let dy = (body["dy"] as? NSNumber)?.doubleValue ?? 0
      let ended = (body["ended"] as? Bool) ?? false
      owner?.handleDrag(dx: CGFloat(dx), dy: CGFloat(dy), ended: ended)
    case "agBarWidth":
      if let w = (body["width"] as? NSNumber)?.doubleValue, w > 60 {
        let h = (body["height"] as? NSNumber)?.doubleValue ?? 34
        owner?.updateStripSize(width: CGFloat(ceil(w)), height: CGFloat(ceil(h)))
      }
    default:
      break
    }
  }
}

@MainActor
final class OverlaySlot {
  let windowId: CGWindowID
  let panel: FloatingBarPanel
  let webView: WKWebView
  let bridge: WebBridge

  init(windowId: CGWindowID, owner: AppController, collapsedSize: NSSize, navDelegate: WKNavigationDelegate, url: URL?) {
    self.windowId = windowId
    self.bridge = WebBridge()
    self.bridge.owner = owner
    self.bridge.windowId = windowId

    let panel = FloatingBarPanel(
      contentRect: NSRect(origin: NSPoint(x: 300, y: 800), size: collapsedSize),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    // 使用 .floating 层级：贴合 Antigravity 窗口上方，不遮挡系统通知横幅
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]

    let ucc = WKUserContentController()
    ucc.add(self.bridge, name: "agPanelState")
    ucc.add(self.bridge, name: "agDrag")
    ucc.add(self.bridge, name: "agBarWidth")

    let cfg = WKWebViewConfiguration()
    cfg.userContentController = ucc

    let webView = WKWebView(frame: NSRect(origin: .zero, size: collapsedSize), configuration: cfg)
    webView.navigationDelegate = navDelegate
    webView.setValue(false, forKey: "drawsBackground")
    webView.autoresizingMask = [.width, .height]
    panel.contentView = webView

    self.panel = panel
    self.webView = webView

    if let url {
      webView.load(URLRequest(url: url))
    }
  }

  func destroy() {
    panel.orderOut(nil)
    webView.configuration.userContentController.removeScriptMessageHandler(forName: "agPanelState")
    webView.configuration.userContentController.removeScriptMessageHandler(forName: "agDrag")
    webView.configuration.userContentController.removeScriptMessageHandler(forName: "agBarWidth")
    panel.close()
  }
}

@MainActor
final class AppController: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  private let port: Int = {
    if let raw = ProcessInfo.processInfo.environment["ATB_PORT"], let p = Int(raw), p > 0 {
      return p
    }
    return 19825
  }()

  private var backendProcess: Process?
  private var statusItem: NSStatusItem!
  private var slots: [CGWindowID: OverlaySlot] = [:]
  private var expandedWindowId: CGWindowID? = nil
  private var serverReady = false

  private var windowTimer: Timer?
  private var summaryTimer: Timer?
  private var overlayVisible = true

  // 严格只展示在 Antigravity 窗口上，其他任何应用与桌面不展示
  private let targetBundleId = "com.google.antigravity"

  private var collapsedSize = NSSize(width: 460, height: 34)
  private let expandedSize = NSSize(width: 960, height: 790)

  private var rightMargin: CGFloat = {
    if UserDefaults.standard.object(forKey: "atb_right_margin_v1") == nil { return 190 }
    return CGFloat(UserDefaults.standard.double(forKey: "atb_right_margin_v1"))
  }()

  private var topOffset: CGFloat = {
    if UserDefaults.standard.object(forKey: "atb_top_offset_v1") == nil { return 0 }
    return CGFloat(UserDefaults.standard.double(forKey: "atb_top_offset_v1"))
  }()

  private var dragOriginRight: CGFloat?
  private var dragOriginTop: CGFloat?

  private var overlayURL: URL? {
    URL(string: "http://127.0.0.1:\(port)/t3-overlay.html")
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)

    setupStatusMenu()
    ensureServerAndLoad()

    // 监听 Antigravity 启动/激活，打开客户端立刻响应展示
    let wsCenter = NSWorkspace.shared.notificationCenter
    wsCenter.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] _ in
      Task { @MainActor in self?.syncWindowPlacement(force: true) }
    }
    wsCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
      Task { @MainActor in self?.syncWindowPlacement(force: true) }
    }

    windowTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.syncWindowPlacement() }
    }
    summaryTimer = Timer.scheduledTimer(withTimeInterval: 3.5, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.refreshStatusPill() }
    }
  }

  func applicationDidResignActive(_ notification: Notification) {
    if expandedWindowId != nil {
      collapsePanel()
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    for slot in slots.values {
      slot.destroy()
    }
    slots.removeAll()
    if let proc = backendProcess, proc.isRunning {
      proc.terminate()
    }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self, weak webView] in
      guard let self, let webView, let url = self.overlayURL else { return }
      webView.load(URLRequest(url: url))
    }
  }

  func updateStripSize(width nextWidth: CGFloat, height nextHeight: CGFloat) {
    let clampedW = min(820, max(220, nextWidth))
    let clampedH = min(52, max(28, nextHeight))
    if abs(collapsedSize.width - clampedW) > 2 || abs(collapsedSize.height - clampedH) > 2 {
      collapsedSize = NSSize(width: clampedW, height: clampedH)
      if expandedWindowId == nil {
        syncWindowPlacement(force: true)
      }
    }
  }

  func setExpanded(_ open: Bool, for windowId: CGWindowID) {
    if open {
      // 如果已有其他窗口展开，先收起它
      if let prevId = expandedWindowId, prevId != windowId, let prevSlot = slots[prevId] {
        prevSlot.webView.evaluateJavaScript("window.__ATBControl?.closeBoard?.();", completionHandler: nil)
        prevSlot.panel.allowKey = false
      }
      expandedWindowId = windowId
      if let slot = slots[windowId] {
        slot.panel.allowKey = true
        slot.panel.hasShadow = false
        syncWindowPlacement(force: true)
        NSApp.activate(ignoringOtherApps: true)
        slot.panel.makeKeyAndOrderFront(nil)
      }
    } else if expandedWindowId == windowId {
      expandedWindowId = nil
      if let slot = slots[windowId] {
        slot.panel.allowKey = false
        slot.panel.hasShadow = false
      }
      syncWindowPlacement(force: true)
    }
  }

  func handleDrag(dx: CGFloat, dy: CGFloat, ended: Bool) {
    if dragOriginRight == nil {
      dragOriginRight = rightMargin
      dragOriginTop = topOffset
    }
    if let br = dragOriginRight, let bt = dragOriginTop {
      rightMargin = max(10, br - dx)
      topOffset = max(-8, min(80, bt + dy))
      syncWindowPlacement()
    }
    if ended {
      dragOriginRight = nil
      dragOriginTop = nil
      UserDefaults.standard.set(Double(rightMargin), forKey: "atb_right_margin_v1")
      UserDefaults.standard.set(Double(topOffset), forKey: "atb_top_offset_v1")
    }
  }

  private func setupStatusMenu() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let btn = statusItem.button {
      btn.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
      btn.title = "🪙 $0.00"
    }

    let menu = NSMenu()

    let toggleBoardItem = NSMenuItem(title: "展开 / 收起 Token 看板", action: #selector(toggleBoardFromMenu), keyEquivalent: "t")
    toggleBoardItem.target = self
    menu.addItem(toggleBoardItem)

    let browserItem = NSMenuItem(title: "在浏览器打开完整看板 (19825)", action: #selector(openBrowserDashboard), keyEquivalent: "o")
    browserItem.target = self
    menu.addItem(browserItem)

    let showBarItem = NSMenuItem(title: "在 Antigravity 顶栏显示指标条", action: #selector(toggleBarVisibility(_:)), keyEquivalent: "")
    showBarItem.target = self
    showBarItem.state = .on
    menu.addItem(showBarItem)

    let resetPosItem = NSMenuItem(title: "重置指标条默认位置", action: #selector(resetBarPosition), keyEquivalent: "")
    resetPosItem.target = self
    menu.addItem(resetPosItem)

    menu.addItem(NSMenuItem.separator())

    let quitItem = NSMenuItem(title: "退出 Token 看板", action: #selector(quitApp), keyEquivalent: "q")
    quitItem.target = self
    menu.addItem(quitItem)

    statusItem.menu = menu
  }

  private func resolveServerScriptPath() -> String? {
    if let envPath = ProcessInfo.processInfo.environment["ATB_SERVER_JS"],
       FileManager.default.fileExists(atPath: envPath) {
      return envPath
    }
    if let resUrl = Bundle.main.url(forResource: "server-path", withExtension: "txt"),
       let raw = try? String(contentsOf: resUrl, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
       FileManager.default.fileExists(atPath: raw) {
      return raw
    }
    return nil
  }

  private func ensureServerAndLoad() {
    guard let healthUrl = URL(string: "http://127.0.0.1:\(port)/healthz") else { return }
    URLSession.shared.dataTask(with: healthUrl) { [weak self] _, resp, _ in
      let healthy = (resp as? HTTPURLResponse)?.statusCode == 200
      Task { @MainActor in
        guard let self else { return }
        if !healthy {
          self.launchLocalServer()
          try? await Task.sleep(nanoseconds: 650_000_000)
        }
        self.serverReady = true
        self.syncWindowPlacement(force: true)
        self.refreshStatusPill()
      }
    }.resume()
  }

  private func launchLocalServer() {
    guard let serverJs = resolveServerScriptPath() else { return }
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/bin/bash")
    proc.arguments = [
      "-c",
      "export PATH=\"$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; exec node --no-warnings \"\(serverJs)\""
    ]
    proc.environment = ProcessInfo.processInfo.environment.merging(["ATB_PORT": "\(port)"]) { _, new in new }
    proc.standardOutput = Pipe()
    proc.standardError = Pipe()
    try? proc.run()
    backendProcess = proc
  }

  private func refreshStatusPill() {
    guard let url = URL(string: "http://127.0.0.1:\(port)/summary-pill") else { return }
    URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
      guard let data,
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
      let todayUsd = (json["todayUSD"] as? NSNumber)?.doubleValue ?? 0
      let ctxPct = Int(round((json["usedPercent"] as? NSNumber)?.doubleValue ?? 0))
      let quotaPct = (json["geminiQuotaPercent"] as? NSNumber)?.intValue
      let quotaPart = quotaPct != nil ? " · ✦ G\(quotaPct!)%" : ""
      let title = String(format: "◔ %d%%%@ · $%.2f", ctxPct, quotaPart, todayUsd)
      Task { @MainActor in
        self?.statusItem.button?.title = title
      }
    }.resume()
  }

  private func findAllAntigravityWindows(pid: pid_t) -> [(windowId: CGWindowID, rect: CGRect, occluded: Bool)] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
      return []
    }
    let selfPid = ProcessInfo.processInfo.processIdentifier
    var coveringWindows: [CGRect] = []
    var results: [(windowId: CGWindowID, rect: CGRect, occluded: Bool)] = []

    for entry in list {
      let ownerPid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? -1
      let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
      guard layer == 0, ownerPid != selfPid else { continue }
      guard let bounds = entry[kCGWindowBounds as String] as? [String: Any],
            let x = (bounds["X"] as? NSNumber)?.doubleValue,
            let y = (bounds["Y"] as? NSNumber)?.doubleValue,
            let w = (bounds["Width"] as? NSNumber)?.doubleValue,
            let h = (bounds["Height"] as? NSNumber)?.doubleValue,
            w >= 260 && h >= 180 else { continue }
      let rect = CGRect(x: x, y: y, width: w, height: h)

      if ownerPid == pid {
        if w >= 420 && h >= 280,
           let widNum = entry[kCGWindowNumber as String] as? NSNumber {
          let wid = CGWindowID(widNum.uint32Value)
          let probe = CGPoint(x: rect.midX, y: rect.minY + 18)
          let occluded = coveringWindows.contains { $0.contains(probe) }
          results.append((wid, rect, occluded))
        }
        // 前面的 Antigravity 窗口也会遮挡后面的 Antigravity 窗口
        coveringWindows.append(rect)
      } else {
        coveringWindows.append(rect)
      }
    }

    return results
  }

  private func resolveAntigravityApp() -> NSRunningApplication? {
    let front = NSWorkspace.shared.frontmostApplication
    // 严格仅当 Antigravity 处于前台时展示；切到任何其他应用/桌面立刻隐藏
    if let f = front, f.bundleIdentifier == targetBundleId {
      return f
    }
    // 面板展开态时（自身短暂获取焦点），保持附着在 Antigravity 窗口上
    if expandedWindowId != nil {
      return NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == targetBundleId })
    }
    return nil
  }

  private func hideAllPanels() {
    for slot in slots.values {
      if slot.panel.isVisible {
        slot.panel.orderOut(nil)
      }
    }
  }

  private func syncWindowPlacement(force: Bool = false) {
    guard serverReady else { return }
    guard overlayVisible else {
      hideAllPanels()
      return
    }

    guard let agyApp = resolveAntigravityApp() else {
      if expandedWindowId == nil {
        hideAllPanels()
      }
      return
    }

    let windows = findAllAntigravityWindows(pid: agyApp.processIdentifier)
    if windows.isEmpty {
      if expandedWindowId == nil {
        hideAllPanels()
      }
      return
    }

    let activeIds = Set(windows.map { $0.windowId })
    // 回收已关闭窗口对应的 OverlaySlot
    for existingId in Array(slots.keys) where !activeIds.contains(existingId) {
      if expandedWindowId == existingId {
        expandedWindowId = nil
      }
      slots[existingId]?.destroy()
      slots.removeValue(forKey: existingId)
    }

    let primaryScreenH = NSScreen.screens.first?.frame.height ?? 900

    for win in windows {
      let isThisExpanded = (expandedWindowId == win.windowId)
      // 如果别的窗口正处于展开态，隐藏其他窗口的小条避免干扰；若被遮挡且未展开也隐藏
      if (expandedWindowId != nil && !isThisExpanded) || (win.occluded && !isThisExpanded) {
        if let slot = slots[win.windowId], slot.panel.isVisible {
          slot.panel.orderOut(nil)
        }
        continue
      }

      let slot: OverlaySlot
      if let existing = slots[win.windowId] {
        slot = existing
      } else {
        slot = OverlaySlot(
          windowId: win.windowId,
          owner: self,
          collapsedSize: collapsedSize,
          navDelegate: self,
          url: overlayURL
        )
        slots[win.windowId] = slot
      }

      let qRect = win.rect
      let size: NSSize
      if isThisExpanded {
        size = NSSize(
          width: min(expandedSize.width, max(640, qRect.width - 28)),
          height: min(expandedSize.height, max(520, qRect.height - 44))
        )
      } else {
        size = collapsedSize
      }

      let safeMinY = qRect.minY < 20 ? 28 : qRect.minY
      let centerX = qRect.midX - size.width / 2
      let clampedX = max(qRect.minX + 12, min(qRect.maxX - size.width - 12, centerX))
      let topY = primaryScreenH - safeMinY - (isThisExpanded ? 32 : 4)
      let nextFrame = NSRect(
        x: clampedX,
        y: topY - size.height,
        width: size.width,
        height: size.height
      )

      if force ||
         abs(slot.panel.frame.origin.x - nextFrame.origin.x) > 0.5 ||
         abs(slot.panel.frame.origin.y - nextFrame.origin.y) > 0.5 ||
         abs(slot.panel.frame.width - nextFrame.width) > 0.5 ||
         abs(slot.panel.frame.height - nextFrame.height) > 0.5 {
        slot.panel.setFrame(nextFrame, display: true)
      }
      if !slot.panel.isVisible {
        slot.panel.orderFrontRegardless()
      }
    }
  }

  private func collapsePanel() {
    if let wid = expandedWindowId, let slot = slots[wid] {
      slot.webView.evaluateJavaScript("window.__ATBControl?.closeBoard?.();", completionHandler: nil)
      setExpanded(false, for: wid)
    }
  }

  @objc private func toggleBoardFromMenu() {
    if expandedWindowId != nil {
      collapsePanel()
    } else {
      if let agy = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == targetBundleId }) {
        agy.activate()
        syncWindowPlacement(force: true)
        if let firstWin = findAllAntigravityWindows(pid: agy.processIdentifier).first,
           let slot = slots[firstWin.windowId] {
          slot.webView.evaluateJavaScript("window.__ATBControl?.toggleBoard?.();", completionHandler: nil)
        }
      }
    }
  }

  @objc private func openBrowserDashboard() {
    if let url = URL(string: "http://127.0.0.1:\(port)/") {
      NSWorkspace.shared.open(url)
    }
  }

  @objc private func toggleBarVisibility(_ sender: NSMenuItem) {
    overlayVisible.toggle()
    sender.state = overlayVisible ? .on : .off
    syncWindowPlacement(force: true)
  }

  @objc private func resetBarPosition() {
    rightMargin = 190
    topOffset = 0
    UserDefaults.standard.set(Double(rightMargin), forKey: "atb_right_margin_v1")
    UserDefaults.standard.set(Double(topOffset), forKey: "atb_top_offset_v1")
    syncWindowPlacement(force: true)
  }

  @objc private func quitApp() {
    NSApplication.shared.terminate(nil)
  }
}

@main
struct TokenBarMain {
  static func main() {
    let selfPid = ProcessInfo.processInfo.processIdentifier
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: "dev.pmlaowangba.antigravity-token-bar")
      .filter { $0.processIdentifier != selfPid }
    for app in running {
      app.terminate()
    }
    if !running.isEmpty {
      Thread.sleep(forTimeInterval: 0.3)
    }
    let app = NSApplication.shared
    let controller = MainActor.assumeIsolated { AppController() }
    app.delegate = controller
    app.run()
  }
}
