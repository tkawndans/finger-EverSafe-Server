const express = require("express");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const { EnvHttpProxyAgent, setGlobalDispatcher } = require("undici");

const nav = require("./lib/navigationPolicy");
const xhrCapture = require("./lib/xhrCapture");
const stealth = require("./lib/stealth");
const { fetchVmScript } = require("./lib/vmScript");
const { STEALTH_ENABLED, mergeStealthHeaders, applyPageStealth } = stealth;

const PORT = process.env.PORT || 3000;

/* Node 내장 fetch는 기본적으로 HTTP(S)_PROXY를 따르지 않음 → Fiddler 등 디버깅 프록시에 안 잡힘.
   프록시 환경 변수가 있으면 undici EnvHttpProxyAgent로 글로벌 디스패처 설정.
   (Node 24+ 에서는 NODE_USE_ENV_PROXY=1 만으로도 동일 효과 가능) */
if (
  process.env.HTTP_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.http_proxy ||
  process.env.https_proxy
) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
  console.log("[proxy] fetch() → HTTP(S)_PROXY 사용 (테스트용 fetchVmScript 등 Node 측 요청 포함)");
}

const SESSION_TTL_MS = 10 * 60 * 1000;

function parseViewportSize() {
  const w = parseInt(process.env.PUPPETEER_VIEWPORT_W || "1920", 10);
  const h = parseInt(process.env.PUPPETEER_VIEWPORT_H || "1080", 10);
  return {
    width: Number.isFinite(w) ? Math.min(Math.max(w, 320), 3840) : 1920,
    height: Number.isFinite(h) ? Math.min(Math.max(h, 240), 2160) : 1080,
  };
}

/* ─────────────────── Chromium path ─────────────────── */

function findChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const cacheDir = path.join(__dirname, ".cache", "puppeteer", "chrome");
  if (!fs.existsSync(cacheDir)) return undefined;
  const vers = fs.readdirSync(cacheDir).sort().reverse();
  for (const v of vers) {
    const exe = path.join(cacheDir, v, "chrome-win64", "chrome.exe");
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}

/* ─────────────────── Browser lifecycle ─────────────────── */

let browser = null;
let headful = process.env.PUPPETEER_HEADFUL === "1";

/** Fiddler 등에 Chromium(XHR) 트래픽까지 잡히게: 예 http://127.0.0.1:8888 */
const PUPPETEER_PROXY = (process.env.PUPPETEER_PROXY || "").trim();

async function launchBrowser() {
  const execPath = findChromePath();
  const args = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"];
  if (STEALTH_ENABLED) {
    args.push("--disable-blink-features=AutomationControlled");
    args.push("--window-size=1920,1080");
    args.push("--lang=ko-KR");
  }
  if (PUPPETEER_PROXY) {
    args.push(`--proxy-server=${PUPPETEER_PROXY}`);
    const bypass = (process.env.PUPPETEER_PROXY_BYPASS || "").trim();
    if (bypass) args.push(`--proxy-bypass-list=${bypass}`);
  }
  console.log(`[browser] launching (headful=${headful}, exec=${execPath || "bundled"}, stealth=${STEALTH_ENABLED})`);
  if (PUPPETEER_PROXY) console.log(`[browser] Chromium proxy: ${PUPPETEER_PROXY}`);
  browser = await puppeteer.launch({
    headless: !headful,
    executablePath: execPath || undefined,
    defaultViewport: null,
    ignoreDefaultArgs: STEALTH_ENABLED ? ["--enable-automation"] : undefined,
    args,
  });
  browser.on("disconnected", () => {
    console.log("[browser] disconnected — will relaunch");
    sessions.clear();
    launchBrowser().catch((e) => console.error("[browser] relaunch failed:", e));
  });
}

async function closeBrowser() {
  if (browser) {
    browser.removeAllListeners("disconnected");
    await browser.close().catch(() => {});
    browser = null;
  }
}

/* ─────────────────── Session store ─────────────────── */

const sessions = new Map();

function touchSession(id) {
  const s = sessions.get(id);
  if (s) s.lastUsed = Date.now();
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > SESSION_TTL_MS) {
      s.page.close().catch(() => {});
      sessions.delete(id);
      console.log(`[session] expired ${id}`);
    }
  }
}, 30_000);

/* ─────────────────── Page (lib: navigationPolicy, stealth, evaluate, vmScript) ─────────────────── */

async function createPage() {
  const page = await browser.newPage();
  const { width, height } = parseViewportSize();
  await page.setViewport({
    width,
    height,
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
  });
  await applyPageStealth(page, browser);
  await page.setRequestInterception(true);
  nav.attachNavigationBlockRecovery(page);
  page.on("request", (req) => {
    if (xhrCapture.handleRequestInCapture(page, req)) {
      return;
    }
    const t = req.resourceType();
    if (["image", "font", "media"].includes(t)) {
      req.abort();
      return;
    }
    if (nav.shouldAbortMainFrameNavigation(req, page)) {
      req.abort();
      return;
    }
    req.continue();
  });
  return page;
}

async function gotoAndWait(page, url, opts = {}) {
  const timeout = opts.timeout || 30_000;
  if (opts.cookies) {
    const parsed = typeof opts.cookies === "string" ? parseCookieString(opts.cookies, url) : opts.cookies;
    if (Array.isArray(parsed) && parsed.length) await page.setCookie(...parsed);
  }
  if (opts.headers && typeof opts.headers === "object") {
    await page.setExtraHTTPHeaders(mergeStealthHeaders(opts.headers));
  }
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });

  if (opts.waitUntilUrlContains) {
    const deadline = Date.now() + timeout;
    while (!page.url().includes(opts.waitUntilUrlContains)) {
      if (Date.now() > deadline) throw new Error(`URL wait timeout: expected "${opts.waitUntilUrlContains}" in URL`);
      await sleep(300);
    }
  }
  const final = page.url();
  nav.recordCompliantUrlAfterGoto(page, final);
  return final;
}

function parseCookieString(str, url) {
  try {
    const u = new URL(url);
    return str.split(";").map((p) => p.trim()).filter(Boolean).map((pair) => {
      const idx = pair.indexOf("=");
      return { name: pair.slice(0, idx), value: pair.slice(idx + 1), domain: u.hostname, path: "/" };
    });
  } catch { return []; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** HTML 또는 전역에서 `var TNK_SR = '...'` 형태 값 추출 */
async function extractTnkSrFromPage(page) {
  const html = await page.content();
  const m = html.match(/var\s+TNK_SR\s*=\s*['"]([^'"]*)['"]\s*;?/i);
  if (m) return m[1];
  return page.evaluate(() => {
    try {
      if (typeof TNK_SR !== "undefined") return TNK_SR;
      const g = typeof globalThis !== "undefined" ? globalThis : window;
      return g.TNK_SR != null ? String(g.TNK_SR) : null;
    } catch (_) {
      return null;
    }
  });
}

/* ─────────────────── Express app ─────────────────── */

const app = express();
app.use(express.json({ limit: "5mb" }));

app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Browser-Admin-Token");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});
app.options("*all", (_req, res) => res.sendStatus(204));

const { registerHealthRoutes } = require("./routes/health");
const { registerBrowserRoutes } = require("./routes/browser");
const { registerSessionRoutes } = require("./routes/session");

registerHealthRoutes(app, {
  getBrowser: () => browser,
  getSessions: () => sessions,
  getHeadful: () => headful,
});
registerBrowserRoutes(app, {
  getHeadful: () => headful,
  setHeadful: (v) => {
    headful = v;
  },
  clearSessions: () => {
    sessions.clear();
  },
  closeBrowser,
  launchBrowser,
});
registerSessionRoutes(app, {
  sessions,
  createPage,
  gotoAndWait,
  touchSession,
  sleep,
  extractTnkSrFromPage,
});

/* ─── Test page ─── */

if (process.env.ENABLE_TEST_PAGE !== "0") {
  const registerTestRoutes = require("./test");
  registerTestRoutes(app, { createPage, fetchVmScript, gotoAndWait });
}

/* ─── Startup ─── */

async function start() {
  console.log(`[server] PUPPETEER_HEADFUL env=${process.env.PUPPETEER_HEADFUL || "(unset)"}`);
  await launchBrowser();
  app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
}

/* ─── Graceful shutdown ─── */

async function shutdown(sig) {
  console.log(`[server] ${sig} received — shutting down`);
  for (const [id, s] of sessions) {
    await s.page.close().catch(() => {});
    sessions.delete(id);
  }
  await closeBrowser();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start().catch((e) => { console.error("[server] startup failed:", e); process.exit(1); });