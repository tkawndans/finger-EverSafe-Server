const warmSession = require("../lib/warmSession");

/**
 * GET /health
 */
function registerHealthRoutes(app, deps) {
  const { getBrowser, getSessions, getHeadful } = deps;

  app.get("/api/v1/ever-safe/health", (_req, res) => {
    const warm = warmSession.getState();
    res.json({
      status: "ok",
      browser: !!getBrowser(),
      sessions: getSessions().size,
      headful: getHeadful(),
      warmEnabled: warm.warmEnabled,
      warmReady: warm.warmReady,
      warmLastError: warm.warmLastError,
      warmSetupInFlight: warm.warmSetupInFlight,
      warmUrl: warm.warmUrl,
      ...(warm.warmConfigError ? { warmConfigError: true } : {}),
    });
  });
}

module.exports = { registerHealthRoutes };
