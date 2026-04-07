/**
 * 테스트 전용: GET /test (test/testPage.html)
 * 운영에서 비활성화: ENABLE_TEST_PAGE=0 node server.js
 */
const fs = require("fs");
const path = require("path");

function registerTestRoutes(app) {
  const htmlPath = path.join(__dirname, "test", "testPage.html");

  app.get("/test", (_req, res) => {
    try {
      const html = fs.readFileSync(htmlPath, "utf8");
      res.type("html").send(html);
    } catch (e) {
      res.status(500).send("Test page file missing: " + htmlPath);
    }
  });
}

module.exports = registerTestRoutes;
