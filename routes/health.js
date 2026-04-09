/**
 * GET /health
 */
function registerHealthRoutes(app, deps) {
  const { getBrowser, getSessions, getHeadful } = deps;

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      browser: !!getBrowser(),
      sessions: getSessions().size,
      headful: getHeadful(),
    });
  });
}

module.exports = { registerHealthRoutes };
