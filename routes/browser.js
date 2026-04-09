/**
 * GET/POST /browser/headful
 */
function registerBrowserRoutes(app, deps) {
  const { getHeadful, setHeadful, clearSessions, closeBrowser, launchBrowser, onAfterBrowserLaunched } = deps;

  app.get("/browser/headful", (_req, res) => res.json({ headful: getHeadful() }));

  app.post("/browser/headful", async (req, res) => {
    const token = process.env.BROWSER_ADMIN_TOKEN;
    if (token && req.headers["x-browser-admin-token"] !== token) {
      return res.status(403).json({ error: "invalid token" });
    }
    const want = req.body && req.body.headful;
    if (typeof want !== "boolean") return res.status(400).json({ error: "headful must be boolean" });

    if (want === getHeadful()) {
      return res.json({ ok: true, headful: getHeadful(), relaunched: false, message: "already in this mode" });
    }
    setHeadful(want);
    clearSessions();
    await closeBrowser();
    await launchBrowser();
    if (typeof onAfterBrowserLaunched === "function") {
      await onAfterBrowserLaunched().catch((e) => console.error("[browser] warm after relaunch failed:", e));
    }
    res.json({
      ok: true,
      headful: getHeadful(),
      relaunched: true,
      message: `switched to ${getHeadful() ? "headful" : "headless"}`,
    });
  });
}

module.exports = { registerBrowserRoutes };
