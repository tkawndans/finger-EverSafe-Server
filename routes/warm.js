const warmSession = require("../lib/warmSession");
const { prepareEvaluateWarmBody } = require("../lib/payloadCustomBase64");
const { buildHealthSnapshot } = require("../lib/healthPayload");
const warmPayloadLog = require("../lib/evaluateWarmPayloadLog");

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
  const { getWarmDeps, getBrowser, getSessions, getHeadful } = deps;

  function healthForThisInstance() {
    return buildHealthSnapshot({ getBrowser, getSessions, getHeadful });
  }

  const evaluateWarmRoute = "POST /api/v1/ever-safe/evaluate/warm";

  /** @param {Record<string, unknown>} fields */
  function appendWarmAutoRecover(fields) {
    if (!warmPayloadLog.isEnabled()) return;
    try {
      warmPayloadLog.append({ phase: "warm_auto_recover", route: evaluateWarmRoute, ...fields });
    } catch (_) {}
  }

  /**
   * warm page 미준비 시 한 번 setupWarmLocked 후 evaluateWarm 재시도 (외부 warm/retry 없이 복구).
   * @param {object} body
   * @param {number} timeoutMs
   */
  async function evaluateWarmWithAutoRecover(body, timeoutMs) {
    const warmDeps = getWarmDeps();
    try {
      return await warmSession.evaluateWarm(body, timeoutMs, warmDeps);
    } catch (firstErr) {
      const msg = firstErr.message || String(firstErr);
      if (!/warm page is not ready/i.test(msg)) throw firstErr;

      console.warn("[warm] evaluate/warm: page not ready — running setupWarm (auto-recover)");
      appendWarmAutoRecover({
        step: "not_ready",
        error: msg,
        stateBefore: warmPayloadLog.truncateJsonString(warmSession.getState(), 4000),
      });

      const setupOut = await warmSession.setupWarmLocked(warmDeps);
      if (setupOut.skipped) {
        appendWarmAutoRecover({ step: "setup_skipped", outcome: "aborted", detail: "WARM_START_URL unset" });
        throw firstErr;
      }
      if (setupOut.busy) {
        appendWarmAutoRecover({ step: "setup_busy", outcome: "aborted" });
        throw firstErr;
      }
      if (!setupOut.ok) {
        const se = setupOut.error || "warm setup failed";
        appendWarmAutoRecover({
          step: "setup_failed",
          outcome: "aborted",
          setupError: se,
          stateAfter: warmPayloadLog.truncateJsonString(warmSession.getState(), 4000),
        });
        throw new Error(`${msg} — auto-recover: warm setup failed: ${se}`);
      }

      appendWarmAutoRecover({
        step: "setup_succeeded",
        outcome: "retrying_evaluate",
        stateAfter: warmPayloadLog.truncateJsonString(warmSession.getState(), 4000),
      });

      try {
        const result = await warmSession.evaluateWarm(body, timeoutMs, warmDeps);
        appendWarmAutoRecover({ step: "evaluate_retry_ok", outcome: "success" });
        return result;
      } catch (secondErr) {
        appendWarmAutoRecover({
          step: "evaluate_retry_failed",
          outcome: "failed",
          error: secondErr.message || String(secondErr),
          stateAfter: warmPayloadLog.truncateJsonString(warmSession.getState(), 4000),
        });
        throw secondErr;
      }
    }
  }

  app.post("/api/v1/ever-safe/evaluate/warm", async (req, res) => {
    try {
      if (warmPayloadLog.isEnabled()) {
        const rb = req.body || {};
        const enc = rb.payload;
        try {
          warmPayloadLog.append({
            phase: "http_request",
            route: evaluateWarmRoute,
            targetUrl: rb.targetUrl,
            timeout: rb.timeout,
            xhrDelegateToClient: !!(rb.xhrDelegateToClient || rb.delegateXhrToClient),
            encodedPayloadLength: typeof enc === "string" ? enc.length : undefined,
            encodedPayloadHead: typeof enc === "string" ? enc.slice(0, 120) : undefined,
          });
        } catch (_) {}
      }

      const body = prepareEvaluateWarmBody(req.body || {});
      const { timeout } = body;
      const t = Number(timeout);
      const timeoutMs = Number.isFinite(t) && t > 0 ? Math.min(t, 600_000) : 30_000;
      const result = await evaluateWarmWithAutoRecover(body, timeoutMs);
      const resp = { result, health: healthForThisInstance() };
      const finalUrl = await warmSession.getWarmPageUrl();
      if (finalUrl) resp.finalUrl = finalUrl;

      if (warmPayloadLog.isEnabled()) {
        try {
          warmPayloadLog.append({
            phase: "http_response",
            route: evaluateWarmRoute,
            httpStatus: 200,
            finalUrl: finalUrl || undefined,
            body: warmPayloadLog.truncateJsonString(resp, 20_000),
          });
        } catch (_) {}
      }

      res.json(resp);
    } catch (e) {
      const code = /not ready|not enabled/i.test(e.message) ? 503 : 400;
      if (warmPayloadLog.isEnabled()) {
        try {
          warmPayloadLog.append({
            phase: "http_error",
            route: evaluateWarmRoute,
            httpStatus: code,
            error: e.message || String(e),
          });
        } catch (_) {}
      }
      res.status(code).json({ error: e.message, health: healthForThisInstance() });
    }
  });

  app.post("/api/v1/ever-safe/warm/retry", async (req, res) => {
    const retryRoute = "POST /api/v1/ever-safe/warm/retry";
    if (warmPayloadLog.isEnabled()) {
      try {
        warmPayloadLog.append({ phase: "http_request", route: retryRoute });
      } catch (_) {}
    }
    if (!checkAdminToken(req, res)) {
      if (warmPayloadLog.isEnabled()) {
        try {
          warmPayloadLog.append({
            phase: "http_error",
            route: retryRoute,
            httpStatus: 403,
            error: "invalid token",
          });
        } catch (_) {}
      }
      return;
    }
    try {
      const out = await warmSession.setupWarmLocked(getWarmDeps());
      if (out.skipped) {
        if (warmPayloadLog.isEnabled()) {
          try {
            warmPayloadLog.append({
              phase: "http_error",
              route: retryRoute,
              httpStatus: 400,
              error: "warm is not configured (WARM_START_URL unset)",
            });
          } catch (_) {}
        }
        return res.status(400).json({ error: "warm is not configured (WARM_START_URL unset)" });
      }
      if (out.busy) {
        if (warmPayloadLog.isEnabled()) {
          try {
            warmPayloadLog.append({
              phase: "http_error",
              route: retryRoute,
              httpStatus: 429,
              error: "warm setup already in progress",
            });
          } catch (_) {}
        }
        return res.status(429).json({ error: "warm setup already in progress" });
      }
      if (!out.ok) {
        const errMsg = out.error || "warm setup failed";
        if (warmPayloadLog.isEnabled()) {
          try {
            warmPayloadLog.append({
              phase: "http_error",
              route: retryRoute,
              httpStatus: 500,
              error: errMsg,
            });
          } catch (_) {}
        }
        return res.status(500).json({ error: errMsg, state: warmSession.getState() });
      }
      const resp = { ok: true, state: warmSession.getState() };
      if (warmPayloadLog.isEnabled()) {
        try {
          warmPayloadLog.append({
            phase: "http_response",
            route: retryRoute,
            httpStatus: 200,
            body: warmPayloadLog.truncateJsonString(resp, 20_000),
          });
        } catch (_) {}
      }
      res.json(resp);
    } catch (e) {
      if (warmPayloadLog.isEnabled()) {
        try {
          warmPayloadLog.append({
            phase: "http_error",
            route: retryRoute,
            httpStatus: 500,
            error: e.message || String(e),
          });
        } catch (_) {}
      }
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerWarmRoutes };
