'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createLogScanner } = require('./log-scanner');
const { createQuotaService } = require('./quota-service');

const WEB_DIR = path.join(__dirname, 'web');
const CHUANBAN_DIR = path.join(__dirname, '..', 'integrations', 'chuanban-page-ledger-board');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function applyCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  applyCorsHeaders(res);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function startTokenBarServer(options = {}) {
  const host = '127.0.0.1';
  const requestedPort = options.port !== undefined ? Number(options.port) : Number(process.env.ATB_PORT || 19825);
  const scanner = createLogScanner({
    brainRootDir: options.brainRootDir,
    brainSources: options.brainSources,
    stateFilePath: options.stateFilePath
  });
  const quotaDisabled = options.disableQuota !== undefined
    ? Boolean(options.disableQuota)
    : Boolean(options.brainRootDir && !options.quotaService);
  const quotaService = options.quotaService || createQuotaService({
    disabled: quotaDisabled
  });
  if (!quotaDisabled) {
    void quotaService.refresh(false);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || '/', `http://${host}`);
      const pathname = urlObj.pathname;

      if (req.method === 'OPTIONS') {
        applyCorsHeaders(res);
        res.writeHead(204);
        res.end();
        return;
      }

      if (pathname === '/healthz') {
        const addr = server.address();
        return sendJson(res, 200, { ok: true, port: addr && typeof addr === 'object' ? addr.port : requestedPort });
      }

      if (pathname === '/api/quota') {
        const force = urlObj.searchParams.get('force') === '1';
        const data = await quotaService.refresh(force);
        return sendJson(res, 200, data);
      }

      if (pathname === '/api/snapshot' || pathname === '/summary-pill') {
        const convId = urlObj.searchParams.get('convId') || undefined;
        const snap = scanner.getSnapshot({
          convId,
          range: urlObj.searchParams.get('range') || undefined,
          grain: urlObj.searchParams.get('grain') || undefined,
          model: urlObj.searchParams.get('model') || undefined,
          workspace: urlObj.searchParams.get('workspace') || undefined,
          category: urlObj.searchParams.get('category') || undefined,
          machine: urlObj.searchParams.get('machine') || undefined,
          fresh: urlObj.searchParams.get('fresh') || undefined
        });
        const quota = quotaService.getCachedOrTriggerRefresh();
        snap.quota = quota;
        if (pathname === '/summary-pill') {
          return sendJson(res, 200, {
            ok: true,
            todayUSD: snap.freshLedger.today.cost.totalUSD,
            totalUSD: snap.freshLedger.allTime.cost.totalUSD,
            totalTokens: snap.freshLedger.allTime.totalTokens,
            usedPercent: snap.activeSession.usedPercent,
            tokensPerSec: snap.activeSession.speed.tokensPerSec,
            activeSource: snap.activeSession.sourceTag || 'AG',
            geminiQuotaPercent: quota?.gemini?.remainingPercent ?? null,
            geminiQuotaResetIn: quota?.gemini?.resetInText || ''
          });
        }
        return sendJson(res, 200, snap);
      }

      if (pathname === '/api/reset-baseline' && req.method === 'POST') {
        const next = scanner.resetBaselineNow();
        return sendJson(res, 200, { ok: true, sinceIso: next.sinceIso, snapshot: scanner.getSnapshot() });
      }

      if (pathname === '/chuanban/custom.css' || pathname === '/chuanban/custom.js') {
        const fileName = path.basename(pathname);
        const target = path.join(CHUANBAN_DIR, fileName);
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Not Found');
        }
        const ext = path.extname(target).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store'
        });
        return res.end(fs.readFileSync(target));
      }

      const assetRel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const safePath = path.normalize(path.join(WEB_DIR, assetRel));
      if (!safePath.startsWith(WEB_DIR) || !fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found');
      }

      const ext = path.extname(safePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(fs.readFileSync(safePath));
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err?.message || 'Internal Server Error' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      const addr = server.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : requestedPort;
      resolve({
        port: actualPort,
        url: `http://${host}:${actualPort}`,
        close: () => new Promise(r => server.close(() => r()))
      });
    });
  });
}

if (require.main === module) {
  startTokenBarServer()
    .then(info => {
      process.stdout.write(`[antigravity-token-bar] listening on ${info.url}\n`);
    })
    .catch(err => {
      process.stderr.write(`[antigravity-token-bar] failed to start: ${err.message}\n`);
      process.exit(1);
    });
}

module.exports = {
  startTokenBarServer
};
