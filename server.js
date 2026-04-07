const express = require("express");
const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const { EnvHttpProxyAgent, setGlobalDispatcher } = require("undici");

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
  console.log("[proxy] fetch() → HTTP(S)_PROXY 사용 (vmLoadBaseUrl 등 Node 측 요청 포함)");
}

const SESSION_TTL_MS = 10 * 60 * 1000;

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

async function launchBrowser() {
  const execPath = findChromePath();
  console.log(`[browser] launching (headful=${headful}, exec=${execPath || "bundled"})`);
  browser = await puppeteer.launch({
    headless: !headful,
    executablePath: execPath || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
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

/* ─────────────────── Page helpers ─────────────────── */

async function createPage() {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const t = req.resourceType();
    if (["image", "font", "media"].includes(t)) req.abort();
    else req.continue();
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
    await page.setExtraHTTPHeaders(opts.headers);
  }
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });

  if (opts.waitUntilUrlContains) {
    const deadline = Date.now() + timeout;
    while (!page.url().includes(opts.waitUntilUrlContains)) {
      if (Date.now() > deadline) throw new Error(`URL wait timeout: expected "${opts.waitUntilUrlContains}" in URL`);
      await sleep(300);
    }
  }
  return page.url();
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

/* ─────────────────── VM script download (Node-side) ─────────────────── */

async function fetchVmScript(baseUrl, page) {
  const sep = baseUrl.includes("?") ? "&" : "?";
  const fullUrl = `${baseUrl}${sep}t=${Date.now()}`;

  const cookies = await page.cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  const res = await fetch(fullUrl, {
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  });
  if (!res.ok) throw new Error(`VM script fetch failed: HTTP ${res.status}`);
  const scriptText = await res.text();
  return { scriptText, fullUrl };
}

/* ─────────────────── Code builders ─────────────────── */

function serializeBody(payload, contentType) {
  if (typeof payload === "string") return payload;
  if (contentType && contentType.includes("json")) return JSON.stringify(payload);
  if (typeof payload === "object") return JSON.stringify(payload);
  return String(payload);
}

function buildXhrPostCode(targetUrl, payload, contentType) {
  const ct = contentType || "application/json";
  const body = serializeBody(payload, ct);
  return `
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', ${JSON.stringify(targetUrl)}, true);
      xhr.setRequestHeader('Content-Type', ${JSON.stringify(ct)});
      xhr.onreadystatechange = function() {
        if (xhr.readyState === 4) {
          let data;
          const respCT = xhr.getResponseHeader('Content-Type') || '';
          const raw = xhr.responseText || '';
          if (respCT.includes('json')) {
            try { data = JSON.parse(raw); } catch(_) { data = raw.substring(0, 2000); }
          } else {
            data = raw.substring(0, 2000);
          }
          resolve({ status: xhr.status, data: data });
        }
      };
      xhr.onerror = function() { reject(new Error('XHR network error')); };
      xhr.send(${JSON.stringify(body)});
    })
  `;
}

/* ─────────────────── Evaluate dispatcher ─────────────────── */

async function executeOnPage(page, body, timeout) {
  const { vmLoadBaseUrl, targetUrl, payload, contentType } = body;
  if (!vmLoadBaseUrl && !(targetUrl && payload !== undefined)) {
    throw new Error("vmLoadBaseUrl 또는 targetUrl+payload 중 하나는 필수입니다");
  }

  if (body.url) {
    await gotoAndWait(page, body.url, {
      timeout,
      waitUntilUrlContains: body.waitUntilUrlContains,
    });
  }

  let vmResult;
  if (vmLoadBaseUrl) {
    const { scriptText, fullUrl } = await fetchVmScript(vmLoadBaseUrl, page);
    await page.evaluate((src) => { eval(src); }, scriptText);
    vmResult = { ok: true, len: scriptText.length, t: fullUrl };
  }

  let xhrResult;
  if (targetUrl && payload !== undefined) {
    const code = buildXhrPostCode(targetUrl, payload, contentType);
    xhrResult = await page.evaluate(code, { timeout });
  }

  if (vmResult && xhrResult) return { vm: vmResult, xhr: xhrResult };
  if (vmResult) return vmResult;
  return xhrResult;
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

/* ─── Health ─── */

app.get("/health", (_req, res) => {
  res.json({ status: "ok", browser: !!browser, sessions: sessions.size, headful });
});

/* ─── Browser headful toggle ─── */

app.get("/browser/headful", (_req, res) => res.json({ headful }));

app.post("/browser/headful", async (req, res) => {
  const token = process.env.BROWSER_ADMIN_TOKEN;
  if (token && req.headers["x-browser-admin-token"] !== token) {
    return res.status(403).json({ error: "invalid token" });
  }
  const want = req.body && req.body.headful;
  if (typeof want !== "boolean") return res.status(400).json({ error: "headful must be boolean" });

  if (want === headful) {
    return res.json({ ok: true, headful, relaunched: false, message: "already in this mode" });
  }
  headful = want;
  sessions.clear();
  await closeBrowser();
  await launchBrowser();
  res.json({ ok: true, headful, relaunched: true, message: `switched to ${headful ? "headful" : "headless"}` });
});

/* ─── Session: create ─── */

app.post("/session/create", async (req, res) => {
  try {
    const { url, cookies, headers, timeout, waitUntilUrlContains } = req.body || {};
    const page = await createPage();
    const sessionId = randomUUID();
    sessions.set(sessionId, { page, createdAt: Date.now(), lastUsed: Date.now() });

    let finalUrl;
    if (url) {
      finalUrl = await gotoAndWait(page, url, { cookies, headers, timeout, waitUntilUrlContains });
    }
    const result = { sessionId };
    if (finalUrl) result.finalUrl = finalUrl;
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─── Session: evaluate ─── */

app.post("/session/evaluate", async (req, res) => {
  try {
    const { sessionId, timeout } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    const sess = sessions.get(sessionId);
    if (!sess) return res.status(404).json({ error: "session not found" });
    touchSession(sessionId);

    const result = await executeOnPage(sess.page, req.body, timeout || 30_000);

    const resp = { result };
    if (req.body.url) resp.finalUrl = sess.page.url();
    res.json(resp);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─── Session: cookies ─── */

app.post("/session/cookies", async (req, res) => {
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

/* ─── Session: destroy ─── */

app.post("/session/destroy", async (req, res) => {
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

/* ─── Session: list ─── */

app.get("/session/list", (_req, res) => {
  const now = Date.now();
  const list = [];
  for (const [id, s] of sessions) {
    list.push({ sessionId: id, createdAt: s.createdAt, ageMs: now - s.createdAt });
  }
  res.json({ sessions: list, count: list.length });
});

/* ─── Stateless evaluate ─── */

app.post("/evaluate", async (req, res) => {
  let page;
  try {
    page = await createPage();
    const { url, cookies, headers, timeout, waitUntilUrlContains } = req.body || {};

    if (url) {
      await gotoAndWait(page, url, { cookies, headers, timeout, waitUntilUrlContains });
    }

    const result = await executeOnPage(page, req.body, timeout || 30_000);
    const resp = { result };
    if (url) resp.finalUrl = page.url();
    res.json(resp);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

/* ─── Test page ─── */

if (process.env.ENABLE_TEST_PAGE !== "0") {
  const registerTestRoutes = require("./test");
  registerTestRoutes(app);
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
