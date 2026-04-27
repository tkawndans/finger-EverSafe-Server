const { buildHealthSnapshot } = require("../lib/healthPayload");
const warmPayloadLog = require("../lib/evaluateWarmPayloadLog");

/**
 * GET /health
 */
function registerHealthRoutes(app, deps) {
  const { getBrowser, getSessions, getHeadful } = deps;

  app.get("/api/v1/ever-safe/health", (_req, res) => {
    const payload = buildHealthSnapshot({ getBrowser, getSessions, getHeadful });

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
