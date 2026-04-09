const warmSession = require("../lib/warmSession");

function checkAdminToken(req, res) {
  const token = process.env.BROWSER_ADMIN_TOKEN;
  if (token && req.headers["x-browser-admin-token"] !== token) {
    res.status(403).json({ error: "invalid token" });
    return false;
  }
  return true;
}

/**
 * POST /evaluate/warm — 웜 페이지에서 XHR(③)만
 * POST /warm/retry — 웜 재구성 (BROWSER_ADMIN_TOKEN 있으면 헤더 필요)
 */
function registerWarmRoutes(app, deps) {
  const { getWarmDeps } = deps;

  app.post("api/v1/ever-safe/evaluate/warm", async (req, res) => {
    try {
      const { timeout } = req.body || {};
      const t = Number(timeout);
      const timeoutMs = Number.isFinite(t) && t > 0 ? Math.min(t, 600_000) : 30_000;
      const result = await warmSession.evaluateWarm(req.body || {}, timeoutMs, getWarmDeps());
      const resp = { result };
      const finalUrl = await warmSession.getWarmPageUrl();
      if (finalUrl) resp.finalUrl = finalUrl;
      res.json(resp);
    } catch (e) {
      const code = /not ready|not enabled/i.test(e.message) ? 503 : 400;
      res.status(code).json({ error: e.message });
    }
  });

  app.post("api/v1/ever-safe/warm/retry", async (req, res) => {
    if (!checkAdminToken(req, res)) return;
    try {
      const out = await warmSession.setupWarmLocked(getWarmDeps());
      if (out.skipped) {
        return res.status(400).json({ error: "warm is not configured (WARM_START_URL unset)" });
      }
      if (out.busy) {
        return res.status(429).json({ error: "warm setup already in progress" });
      }
      if (!out.ok) {
        return res.status(500).json({ error: out.error || "warm setup failed", state: warmSession.getState() });
      }
      res.json({ ok: true, state: warmSession.getState() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerWarmRoutes };
