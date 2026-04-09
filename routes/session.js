const { randomUUID } = require("crypto");
const nav = require("../lib/navigationPolicy");
const { executeOnPage } = require("../lib/evaluate");

/**
 * /session/* , POST /evaluate
 */
function registerSessionRoutes(app, deps) {
  const {
    sessions,
    createPage,
    gotoAndWait,
    touchSession,
    sleep,
    extractTnkSrFromPage,
  } = deps;

  app.post("api/v1/ever-safe/session/create", async (req, res) => {
    try {
      const {
        url,
        cookies,
        headers,
        timeout,
        waitUntilUrlContains,
        extractTnkSr,
        extractTnkSrWaitMs,
        navigationBlockedUrlPrefixes,
        navigationAllowedUrlPrefixes,
      } = req.body || {};
      const page = await createPage();
      await nav.applyNavigationPolicy(page, navigationBlockedUrlPrefixes, navigationAllowedUrlPrefixes);
      const sessionId = randomUUID();
      sessions.set(sessionId, { page, createdAt: Date.now(), lastUsed: Date.now() });

      const result = { sessionId };
      let finalUrl;
      if (url) {
        finalUrl = await gotoAndWait(page, url, { cookies, headers, timeout, waitUntilUrlContains });
        if (extractTnkSr) {
          const w = Number(extractTnkSrWaitMs);
          if (Number.isFinite(w) && w > 0) await sleep(Math.min(w, 60_000));
          const tnk = await extractTnkSrFromPage(page);
          if (tnk != null) result.TNK_SR = tnk;
        }
      }
      if (finalUrl) result.finalUrl = finalUrl;
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("api/v1/ever-safe/session/evaluate", async (req, res) => {
    try {
      const { sessionId, timeout } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: "sessionId required" });
      const sess = sessions.get(sessionId);
      if (!sess) return res.status(404).json({ error: "session not found" });
      touchSession(sessionId);

      await nav.applyNavigationPolicy(
        sess.page,
        req.body && req.body.navigationBlockedUrlPrefixes,
        req.body && req.body.navigationAllowedUrlPrefixes,
      );

      const result = await executeOnPage(sess.page, req.body, timeout || 30_000, { gotoAndWait });

      const resp = { result };
      if (req.body.url) resp.finalUrl = sess.page.url();
      res.json(resp);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("api/v1/ever-safe/session/cookies", async (req, res) => {
    try {
      const { sessionId } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: "sessionId required" });
      const sess = sessions.get(sessionId);
      if (!sess) return res.status(404).json({ error: "session not found" });
      touchSession(sessionId);
      const cookies = await sess.page.cookies();
      res.json({ cookies });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("api/v1/ever-safe/session/destroy", async (req, res) => {
    try {
      const { sessionId } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: "sessionId required" });
      const sess = sessions.get(sessionId);
      if (sess) {
        await sess.page.close().catch(() => {});
        sessions.delete(sessionId);
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("api/v1/ever-safe/session/list", (_req, res) => {
    const now = Date.now();
    const list = [];
    for (const [id, s] of sessions) {
      list.push({ sessionId: id, createdAt: s.createdAt, ageMs: now - s.createdAt });
    }
    res.json({ sessions: list, count: list.length });
  });

  app.post("api/v1/ever-safe/evaluate", async (req, res) => {
    let page;
    try {
      page = await createPage();
      await nav.applyNavigationPolicy(
        page,
        req.body && req.body.navigationBlockedUrlPrefixes,
        req.body && req.body.navigationAllowedUrlPrefixes,
      );
      const { url, cookies, headers, timeout, waitUntilUrlContains } = req.body || {};

      if (url) {
        await gotoAndWait(page, url, { cookies, headers, timeout, waitUntilUrlContains });
      }

      const result = await executeOnPage(page, req.body, timeout || 30_000, { gotoAndWait });
      const resp = { result };
      if (url) resp.finalUrl = page.url();
      res.json(resp);
    } catch (e) {
      res.status(500).json({ error: e.message });
    } finally {
      if (page) await page.close().catch(() => {});
    }
  });
}

module.exports = { registerSessionRoutes };
