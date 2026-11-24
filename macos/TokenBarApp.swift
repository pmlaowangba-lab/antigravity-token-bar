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
  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any] else { return }
    switch message.name {
    case "agPanelState":
      let open = (body["open"] as? Bool) ?? false
      owner?.setExpanded(open)
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
final class AppController: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  private let port: Int = {
    if let raw = ProcessInfo.processInfo.environment["ATB_PORT"], let p = Int(raw), p > 0 {
      return p
    }
    return 19825
  }()

  private var backendProcess: Process?
  private var statusItem: NSStatusItem!
  private var panel: FloatingBarPanel!
  private var webView: WKWebView!
  private let bridge = WebBridge()

  private var windowTimer: Timer?
  private var summaryTimer: Timer?
  private var isExpanded = false
  private var overlayVisible = true

  // 仅在 Antigravity 或 T3 Code 窗口处于前台时展示，其他应用与桌面自动隐藏
  private let targetBundleIds: Set<String> = ["com.google.antigravity", "com.t3tools.t3code"]
  private var lastHostBundleId: String = "com.google.antigravity"

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

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    bridge.owner = self

    setupStatusMenu()
    setupFloatingPanel()
    ensureServerAndLoad()

    windowTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.syncWindowPlacement() }
    }
    summaryTimer = Timer.scheduledTimer(withTimeInterval: 3.5, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.refreshStatusPill() }
    }
  }

  func applicationDidResignActive(_ notification: Notification) {
    if isExpanded {
      collapsePanel()
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    if let proc = backendProcess, proc.isRunning {
      proc.terminate()
    }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
      self?.loadOverlayPage()
    }
  }

  func updateStripSize(width nextWidth: CGFloat, height nextHeight: CGFloat) {
    let clampedW = min(820, max(220, nextWidth))
    let clampedH = min(52, max(28, nextHeight))
    if abs(collapsedSize.width - clampedW) > 2 || abs(collapsedSize.height - clampedH) > 2 {
      collapsedSize = NSSize(width: clampedW, height: clampedH)
      if !isExpanded {
        syncWindowPlacement(force: true)
      }
    }
  }

  func setExpanded(_ open: Bool) {
    guard isExpanded != open else { return }
    isExpanded = open
    panel.allowKey = open
    panel.hasShadow = false
    syncWindowPlacement(force: true)
    if open {
      NSApp.activate(ignoringOtherApps: true)
      panel.makeKeyAndOrderFront(nil)
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
    let toggleItem = NSMenuItem(title: "展开 / 收起用量大看板", action: #selector(toggleBoardFromMenu), keyEquivalent: "t")
    toggleItem.target = self
    menu.addItem(toggleItem)

    let browserItem = NSMenuItem(title: "在浏览器打开独立全屏看板", action: #selector(openBrowserDashboard), keyEquivalent: "o")
    browserItem.target = self
    menu.addItem(browserItem)

    let showBarItem = NSMenuItem(title: "在 Antigravity / T3 Code 顶栏显示指标条", action: #selector(toggleBarVisibility(_:)), keyEquivalent: "")
    showBarItem.target = self
    showBarItem.state = .on
    menu.addItem(showBarItem)

    let resetPosItem = NSMenuItem(title: "重置顶栏贴顶位置", action: #selector(resetBarPosition), keyEquivalent: "r")
    resetPosItem.target = self
    menu.addItem(resetPosItem)

    menu.addItem(NSMenuItem.separator())
    let quitItem = NSMenuItem(title: "退出 Antigravity Token Bar", action: #selector(quitApp), keyEquivalent: "q")
    quitItem.target = self
    menu.addItem(quitItem)

    statusItem.menu = menu
  }

  private func setupFloatingPanel() {
    panel = FloatingBarPanel(
      contentRect: NSRect(origin: NSPoint(x: 300, y: 800), size: collapsedSize),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    // 使用 .floating 层级：稳固贴合应用窗口上方，同时低于 macOS 系统通知横幅，绝不遮挡微信/系统通知
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]

    let ucc = WKUserContentController()
    ucc.add(bridge, name: "agPanelState")
    ucc.add(bridge, name: "agDrag")
    ucc.add(bridge, name: "agBarWidth")

    let cfg = WKWebViewConfiguration()
    cfg.userContentController = ucc

    webView = WKWebView(frame: NSRect(origin: .zero, size: collapsedSize), configuration: cfg)
    webView.navigationDelegate = self
    webView.setValue(false, forKey: "drawsBackground")
    webView.autoresizingMask = [.width, .height]
    panel.contentView = webView
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
        self.loadOverlayPage()
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
      "export PATH=\"/opt/homebrew/bin:/usr/local/bin:$PATH\"; exec node --no-warnings \"\(serverJs)\""
    ]
    proc.environment = ProcessInfo.processInfo.environment.merging(["ATB_PORT": "\(port)"]) { _, new in new }
    proc.standardOutput = Pipe()
    proc.standardError = Pipe()
    try? proc.run()
    backendProcess = proc
  }

  private func loadOverlayPage() {
    if let url = URL(string: "http://127.0.0.1:\(port)/t3-overlay.html") {
      webView.load(URLRequest(url: url))
    }
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

  private func findTargetWindow(pid: pid_t) -> (rect: CGRect, occluded: Bool)? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
      return nil
    }
    let selfPid = ProcessInfo.processInfo.processIdentifier
    var coveringWindows: [CGRect] = []
    var targetRect: CGRect?

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
        if w >= 420 && h >= 280 {
          targetRect = rect
          break
        }
      } else {
        coveringWindows.append(rect)
      }
    }

    guard let found = targetRect else { return nil }
    let probe = CGPoint(x: max(found.minX + 60, found.maxX - rightMargin - 100), y: found.minY + 16)
    let occluded = coveringWindows.contains { $0.contains(probe) }
    return (found, occluded)
  }

  private func resolveTargetHostApp() -> NSRunningApplication? {
    let front = NSWorkspace.shared.frontmostApplication
    // 仅当 Antigravity 或 T3 Code 处于前台时展示；切到任何其他应用/桌面立刻隐藏
    if let f = front, let bid = f.bundleIdentifier, targetBundleIds.contains(bid) {
      lastHostBundleId = bid
      return f
    }
    // 面板展开态时（自身短暂获取焦点），保持附着在最近一次宿主窗口上
    if isExpanded {
      let running = NSWorkspace.shared.runningApplications
      return running.first(where: { $0.bundleIdentifier == lastHostBundleId })
        ?? running.first(where: { $0.bundleIdentifier.map { targetBundleIds.contains($0) } ?? false })
    }
    return nil
  }

  private func syncWindowPlacement(force: Bool = false) {
    guard overlayVisible else {
      if panel.isVisible { panel.orderOut(nil) }
      return
    }

    let primaryScreenH = NSScreen.screens.first?.frame.height ?? 900
    guard let hostApp = resolveTargetHostApp(),
          let winInfo = findTargetWindow(pid: hostApp.processIdentifier) else {
      if !isExpanded && panel.isVisible {
        panel.orderOut(nil)
      }
      return
    }

    if winInfo.occluded && !isExpanded {
      if panel.isVisible { panel.orderOut(nil) }
      return
    }

    let qRect = winInfo.rect
    let size: NSSize
    if isExpanded {
      size = NSSize(
        width: min(expandedSize.width, max(640, qRect.width - 28)),
        height: min(expandedSize.height, max(520, qRect.height - 44))
      )
    } else {
      size = collapsedSize
    }

    let safeMinY = qRect.minY < 20 ? 28 : qRect.minY
    // 在宿主窗口顶部水平居中展示（避免遮挡右侧 Open IDE 等按钮）
    let centerX = qRect.midX - size.width / 2
    let clampedX = max(qRect.minX + 12, min(qRect.maxX - size.width - 12, centerX))
    let topY = primaryScreenH - safeMinY - (isExpanded ? 32 : 4)
    let nextFrame = NSRect(
      x: clampedX,
      y: topY - size.height,
      width: size.width,
      height: size.height
    )
    if force ||
       abs(panel.frame.origin.x - nextFrame.origin.x) > 0.5 ||
       abs(panel.frame.origin.y - nextFrame.origin.y) > 0.5 ||
       abs(panel.frame.width - nextFrame.width) > 0.5 ||
       abs(panel.frame.height - nextFrame.height) > 0.5 {
      panel.setFrame(nextFrame, display: true)
    }
    if !panel.isVisible {
      panel.orderFrontRegardless()
    }
  }

  private func collapsePanel() {
    webView.evaluateJavaScript("window.__ATBControl?.closeBoard?.();", completionHandler: nil)
    setExpanded(false)
  }

  @objc private func toggleBoardFromMenu() {
    if isExpanded {
      collapsePanel()
    } else {
      let running = NSWorkspace.shared.runningApplications
      let target = running.first(where: { $0.bundleIdentifier == lastHostBundleId })
        ?? running.first(where: { $0.bundleIdentifier.map { targetBundleIds.contains($0) } ?? false })
      target?.activate()
      webView.evaluateJavaScript("window.__ATBControl?.toggleBoard?.();", completionHandler: nil)
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
    syncWindowPlacement()
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
