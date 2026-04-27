const warmSession = require("../lib/warmSession");
const { ALPHABET_LEN } = require("../lib/payloadCustomBase64");
const warmPayloadLog = require("../lib/evaluateWarmPayloadLog");

/**
 * GET /health
 */
function registerHealthRoutes(app, deps) {
  const { getBrowser, getSessions, getHeadful } = deps;

  app.get("/api/v1/ever-safe/health", (_req, res) => {
    const warm = warmSession.getState();
    const tokenTrim = (process.env.BROWSER_ADMIN_TOKEN || "").trim();
    const payload = {
      status: "ok",
      browser: !!getBrowser(),
      sessions: getSessions().size,
      headful: getHeadful(),
      warmEnabled: warm.warmEnabled,
      warmReady: warm.warmReady,
      warmLastError: warm.warmLastError,
      warmSetupInFlight: warm.warmSetupInFlight,
      warmUrl: warm.warmUrl,
      /** POST /evaluate/warm payload 디코드에 필요(BROWSER_ADMIN_TOKEN 정확히 ALPHABET_LEN 자) */
      warmPayloadEncodingReady: tokenTrim.length === ALPHABET_LEN,
      ...(warm.warmConfigError ? { warmConfigError: true } : {}),
    };

    if (warmPayloadLog.isEnabled()) {
      try {
        warmPayloadLog.append({
          phase: "http_health",
          route: "GET /api/v1/ever-safe/health",
          body: warmPayloadLog.truncateJsonString(payload, 12_000),
        });
      } catch (_) {}
    }

    res.json(payload);
  });
}

module.exports = { registerHealthRoutes };
