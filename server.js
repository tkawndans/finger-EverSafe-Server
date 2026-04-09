const express = require("express");
const { randomUUID } = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
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
  console.log("[proxy] fetch() → HTTP(S)_PROXY 사용 (테스트용 fetchVmScript 등 Node 측 요청 포함)");
}

const SESSION_TTL_MS = 10 * 60 * 1000;

/** `PUPPETEER_DISABLE_STEALTH=1` 이면 아래 우회 전부 비활성화(디버깅용). */
const STEALTH_ENABLED = process.env.PUPPETEER_DISABLE_STEALTH !== "1";
const STEALTH_ACCEPT_LANGUAGE =
  (process.env.PUPPETEER_ACCEPT_LANGUAGE || "").trim() ||
  "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7";

function mergeStealthHeaders(userHeaders) {
  if (!STEALTH_ENABLED) return userHeaders && typeof userHeaders === "object" ? userHeaders : {};
  const base = { "Accept-Language": STEALTH_ACCEPT_LANGUAGE };
  if (!userHeaders || typeof userHeaders !== "object") return base;
  return { ...base, ...userHeaders };
}

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

/* ─────────────────── Navigation policy (per Page) ─────────────────── */

const pageNavigationBlockedPrefixes = new WeakMap();
/** 비어 있지 않으면: 메인 프레임 document 네비는 이 접두사 중 하나로만 허용(화이트리스트) */
const pageNavigationAllowedPrefixes = new WeakMap();
/** 정책을 만족하는 마지막 메인 프레임 URL(복구용) */
const pageLastAllowedMainFrameUrl = new WeakMap();
/** 마지막으로 성공한 `vmLoadBaseUrl` 문자열 — 네비 복구 후 VM 재주입용 */
const pageLastVmLoadBaseUrl = new WeakMap();

/** `PUPPETEER_NO_VM_REINJECT_AFTER_RESTORE=1` 이면 복구 후 자동 VM 재주입 안 함(이중 초기화 회피) */
const VM_REINJECT_AFTER_RESTORE = process.env.PUPPETEER_NO_VM_REINJECT_AFTER_RESTORE !== "1";

function normalizeNavigationPrefixList(input) {
  if (!Array.isArray(input)) return [];
  return input.map((s) => String(s).trim()).filter(Boolean);
}

/** 접두사 일치 + 동일 origin에서 path+search 접두 일치 */
function urlMatchesBlockedPrefixes(urlStr, blockPrefixes) {
  if (!urlStr || !blockPrefixes || !blockPrefixes.length) return false;
  const candidate = String(urlStr).trim();
  for (const prefix of blockPrefixes) {
    const p = String(prefix).trim();
    if (!p) continue;
    if (candidate.startsWith(p)) return true;
    try {
      const U = new URL(candidate);
      const P = new URL(p);
      if (U.origin !== P.origin) continue;
      const pathU = U.pathname + U.search;
      const pathP = P.pathname + P.search;
      if (pathU.startsWith(pathP)) return true;
    } catch (_) {
      /* ignore */
    }
  }
  return false;
}

/** allowPrefixes 비어 있으면 제한 없음. 있으면 하나 이상의 접두와 일치해야 함(차단 목록보다 후순위로 검사). */
function urlMatchesAllowedPrefixes(urlStr, allowPrefixes) {
  if (!allowPrefixes || !allowPrefixes.length) return true;
  const candidate = String(urlStr).trim();
  for (const prefix of allowPrefixes) {
    const p = String(prefix).trim();
    if (!p) continue;
    if (candidate.startsWith(p)) return true;
    try {
      const U = new URL(candidate);
      const P = new URL(p);
      if (U.origin !== P.origin) continue;
      const pathU = U.pathname + U.search;
      const pathP = P.pathname + P.search;
      if (pathU.startsWith(pathP)) return true;
    } catch (_) {
      /* ignore */
    }
  }
  return false;
}

function isUrlCompliantWithNavigationPolicy(u, allowPrefixes, blockPrefixes) {
  const allow = allowPrefixes || [];
  const block = blockPrefixes || [];
  if (urlMatchesBlockedPrefixes(u, block)) return false;
  if (allow.length && !urlMatchesAllowedPrefixes(u, allow)) return false;
  return true;
}

/** 현재 페이지 URL의 디렉터리 접두(예: …/inbank/pr/ma/) — 화이트리스트 자동 구성용 */
function autoNavigationAllowPrefixFromPageUrl(pageUrlStr) {
  try {
    const u = new URL(pageUrlStr);
    if (!u.protocol.startsWith("http")) return "";
    const path = u.pathname;
    const lastSlash = path.lastIndexOf("/");
    const dir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "/";
    return u.origin + dir;
  } catch (_) {
    return "";
  }
}

function isMainFrameDocumentNavigation(req, page) {
  let f = null;
  try {
    f = req.frame();
  } catch (_) {
    return false;
  }
  if (!f || f !== page.mainFrame()) return false;
  if (req.isNavigationRequest()) return true;
  if (req.resourceType() === "document") return true;
  return false;
}

/**
 * `navigationBlockedUrlPrefixes` / `navigationAllowedUrlPrefixes` 각각
 * `undefined` 이면 해당 목록은 변경하지 않음, `[]` 이면 비움.
 * 허용 목록이 비어 있지 않으면 메인 프레임 document 이동이 그 접두사로만 가능(차단보다 강함).
 */
async function applyNavigationPolicy(page, navigationBlockedUrlPrefixes, navigationAllowedUrlPrefixes) {
  if (navigationBlockedUrlPrefixes !== undefined) {
    const list = normalizeNavigationPrefixList(navigationBlockedUrlPrefixes);
    if (list.length) pageNavigationBlockedPrefixes.set(page, list);
    else pageNavigationBlockedPrefixes.delete(page);
  }
  if (navigationAllowedUrlPrefixes !== undefined) {
    const list = normalizeNavigationPrefixList(navigationAllowedUrlPrefixes);
    if (list.length) pageNavigationAllowedPrefixes.set(page, list);
    else pageNavigationAllowedPrefixes.delete(page);
  }

  const blocked = pageNavigationBlockedPrefixes.get(page) || [];
  const allowed = pageNavigationAllowedPrefixes.get(page) || [];

  await page.evaluateOnNewDocument((cfg) => {
    window.__NAV_BLOCK_PREFIXES__ = cfg.blocked.slice();
    window.__NAV_ALLOW_PREFIXES__ = cfg.allowed.slice();
    if (window.__navPolicyPatched) return;
    window.__navPolicyPatched = true;

    const navDisallowed = (urlArg) => {
      if (urlArg == null || urlArg === "") return false;
      let abs;
      try {
        abs = new URL(String(urlArg), location.href).href;
      } catch (_) {
        return false;
      }
      const blocks = window.__NAV_BLOCK_PREFIXES__ || [];
      for (let i = 0; i < blocks.length; i++) {
        if (abs.startsWith(blocks[i])) return true;
      }
      const allows = window.__NAV_ALLOW_PREFIXES__ || [];
      if (allows.length === 0) return false;
      return !allows.some((a) => abs.startsWith(a));
    };

    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState = function (state, title, url) {
      if (navDisallowed(url)) return;
      return origPush(state, title, url);
    };
    history.replaceState = function (state, title, url) {
      if (navDisallowed(url)) return;
      return origReplace(state, title, url);
    };
    try {
      const oa = Location.prototype.assign;
      const or = Location.prototype.replace;
      Location.prototype.assign = function (url) {
        if (navDisallowed(url)) return;
        return oa.call(this, url);
      };
      Location.prototype.replace = function (url) {
        if (navDisallowed(url)) return;
        return or.call(this, url);
      };
    } catch (_) {
      /* ignore */
    }
  }, { blocked, allowed });

  try {
    await page.evaluate((cfg) => {
      window.__NAV_BLOCK_PREFIXES__ = cfg.blocked.slice();
      window.__NAV_ALLOW_PREFIXES__ = cfg.allowed.slice();
    }, { blocked, allowed });
  } catch (_) {
    /* ignore */
  }
}

async function reinjectVmScriptAfterRestore(page) {
  if (!pageLastVmLoadBaseUrl.get(page) || !VM_REINJECT_AFTER_RESTORE) return;
  const { scriptText } = await readEverSafeVmScript();
  const blocked = pageNavigationBlockedPrefixes.get(page) || [];
  const allowed = pageNavigationAllowedPrefixes.get(page) || [];
  let combined = scriptText;
  if (blocked.length || allowed.length) {
    combined = `${buildVmNavigationGuardPrefixString(blocked, allowed)}\n${scriptText}`;
  }
  await page.evaluate((src) => {
    eval(src);
  }, combined);
}

async function restoreMainFrameIfNavigationPolicyViolated(page) {
  let u = "";
  try {
    u = page.url();
  } catch (_) {
    return;
  }
  const allowed = pageNavigationAllowedPrefixes.get(page) || [];
  const blocked = pageNavigationBlockedPrefixes.get(page) || [];
  if (isUrlCompliantWithNavigationPolicy(u, allowed, blocked)) return;

  const back = pageLastAllowedMainFrameUrl.get(page);
  let restored = false;

  try {
    const histLen = await page.evaluate(() => window.history.length);
    if (histLen > 1) {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
      restored = true;
    }
  } catch (_) {
    /* ignore */
  }

  try {
    u = page.url();
  } catch (_) {
    return;
  }
  if (!isUrlCompliantWithNavigationPolicy(u, allowed, blocked) && back) {
    await page.goto(back, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    restored = true;
  } else if (!isUrlCompliantWithNavigationPolicy(u, allowed, blocked) && !restored) {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
    restored = true;
  }

  try {
    u = page.url();
  } catch (_) {
    return;
  }
  if (!isUrlCompliantWithNavigationPolicy(u, allowed, blocked)) return;

  if (restored && VM_REINJECT_AFTER_RESTORE && pageLastVmLoadBaseUrl.get(page)) {
    await reinjectVmScriptAfterRestore(page).catch((e) => {
      console.warn("[nav] VM reinject after restore failed:", e && e.message ? e.message : e);
    });
  }
}

/**
 * abort() 후에도 주소창이 남는 경우 복구. 화이트리스트 위반 시에도 동일.
 */
function attachNavigationBlockRecovery(page) {
  let restoreInFlight = null;

  const runRestore = () => {
    if (restoreInFlight) return restoreInFlight;
    restoreInFlight = (async () => {
      try {
        await restoreMainFrameIfNavigationPolicyViolated(page);
      } finally {
        restoreInFlight = null;
      }
    })();
    return restoreInFlight;
  };

  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    let u = "";
    try {
      u = page.url();
    } catch (_) {
      return;
    }
    const allowed = pageNavigationAllowedPrefixes.get(page) || [];
    const blocked = pageNavigationBlockedPrefixes.get(page) || [];
    if (isUrlCompliantWithNavigationPolicy(u, allowed, blocked)) {
      pageLastAllowedMainFrameUrl.set(page, u);
    } else {
      void runRestore();
    }
  });

  page.on("requestfailed", (request) => {
    if (!request.isNavigationRequest()) return;
    const u = request.url();
    const allowed = pageNavigationAllowedPrefixes.get(page) || [];
    const blocked = pageNavigationBlockedPrefixes.get(page) || [];
    if (isUrlCompliantWithNavigationPolicy(u, allowed, blocked)) return;
    void runRestore();
  });

  page.on("load", () => {
    void runRestore();
  });
}

/* ─────────────────── Page helpers ─────────────────── */

/** Chromium 버전 문자열에서 major / full 버전 추출 */
function parseChromeVersionFromBrowserStrings(versionLine, fallbackFull = "131.0.0.0") {
  const m = versionLine && versionLine.match(/\/([\d.]+)/);
  const fullVersion = m ? m[1] : fallbackFull;
  const major = fullVersion.split(".")[0] || "131";
  return { fullVersion, major };
}

/** UA 문자열 정리 + Client Hints 메타데이터(브라우저 실제 버전과 맞춤) */
async function applyStealthUserAgent(page) {
  const rawUa = await browser.userAgent();
  const verLine = await browser.version();
  const { fullVersion, major } = parseChromeVersionFromBrowserStrings(verLine);

  let ua = (process.env.PUPPETEER_USER_AGENT || "").trim();
  if (!ua) ua = rawUa.replace(/\bHeadlessChrome\b/gi, "Chrome");

  const metadata = {
    brands: [
      { brand: "Google Chrome", version: major },
      { brand: "Chromium", version: major },
      { brand: "Not-A.Brand", version: "24" },
    ],
    fullVersion,
    fullVersionList: [
      { brand: "Google Chrome", version: fullVersion },
      { brand: "Chromium", version: fullVersion },
      { brand: "Not-A.Brand", version: "24.0.0.0" },
    ],
    platform: "Windows",
    platformVersion: "19.0.0",
    architecture: "x86",
    model: "",
    mobile: false,
    bitness: "64",
    wow64: false,
  };

  await page.setUserAgent(ua, metadata);
}

/**
 * 페이지 스크립트보다 먼저 실행: webdriver·languages·chrome·permissions·connection 등
 * (puppeteer-extra-stealth 등과 유사한 흔한 패턴 — 의존성 추가 없이 최소 구현)
 */
async function installStealthInitScript(page, languages) {
  const langs = Array.isArray(languages) && languages.length ? languages : ["ko-KR", "ko", "en-US", "en"];
  await page.evaluateOnNewDocument((cfg) => {
    const L = cfg.langs;
    const Nav = Navigator.prototype;

    const safeDefine = (obj, key, desc) => {
      try {
        Object.defineProperty(obj, key, desc);
      } catch (_) {
        /* ignore */
      }
    };

    safeDefine(Nav, "webdriver", {
      get() {
        return false;
      },
      configurable: true,
    });

    safeDefine(Nav, "languages", {
      get() {
        return L.slice();
      },
      configurable: true,
    });

    safeDefine(Nav, "maxTouchPoints", {
      get() {
        return 0;
      },
      configurable: true,
    });

    try {
      if (typeof window.chrome === "undefined") window.chrome = {};
      if (!window.chrome.runtime) {
        window.chrome.runtime = {
          connect: function () {
            return {
              onMessage: { addListener() {}, removeListener() {} },
              postMessage() {},
              disconnect() {},
            };
          },
          sendMessage() {},
          getManifest() {
            return { name: "Chrome", version: "1.0", manifest_version: 3 };
          },
        };
      }
    } catch (_) {
      /* ignore */
    }

    try {
      const perms = navigator.permissions;
      if (perms && typeof perms.query === "function") {
        const orig = perms.query.bind(perms);
        perms.query = function (params) {
          if (params && params.name === "notifications") {
            const state =
              typeof Notification !== "undefined" && Notification.permission
                ? Notification.permission
                : "default";
            return Promise.resolve({ state, onchange: null });
          }
          return orig(params);
        };
      }
    } catch (_) {
      /* ignore */
    }

    try {
      safeDefine(Nav, "connection", {
        get() {
          return {
            downlink: 10,
            effectiveType: "4g",
            rtt: 50,
            saveData: false,
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() {
              return false;
            },
          };
        },
        configurable: true,
      });
    } catch (_) {
      /* ignore */
    }

    try {
      for (const k of Object.keys(window)) {
        if (/^cdc_[a-zA-Z0-9_]+$/.test(k)) {
          try {
            delete window[k];
          } catch (_) {
            /* ignore */
          }
        }
      }
    } catch (_) {
      /* ignore */
    }

  }, { langs });
}

async function applyPageStealth(page) {
  if (!STEALTH_ENABLED) return;

  await applyStealthUserAgent(page);

  const langList = (process.env.PUPPETEER_NAVIGATOR_LANGUAGES || "ko-KR,ko,en-US,en")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  await installStealthInitScript(page, langList);
  await page.setExtraHTTPHeaders(mergeStealthHeaders());
}

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
  await applyPageStealth(page);
  await page.setRequestInterception(true);
  attachNavigationBlockRecovery(page);
  page.on("request", (req) => {
    const t = req.resourceType();
    if (["image", "font", "media"].includes(t)) {
      req.abort();
      return;
    }
    const u = req.url();
    const allowed = pageNavigationAllowedPrefixes.get(page) || [];
    const blocked = pageNavigationBlockedPrefixes.get(page) || [];
    if (isMainFrameDocumentNavigation(req, page) && !isUrlCompliantWithNavigationPolicy(u, allowed, blocked)) {
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
  const allowed = pageNavigationAllowedPrefixes.get(page) || [];
  const blocked = pageNavigationBlockedPrefixes.get(page) || [];
  if (isUrlCompliantWithNavigationPolicy(final, allowed, blocked)) {
    pageLastAllowedMainFrameUrl.set(page, final);
  }
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

/** undici/fetch 실패 시 cause 체인을 한 줄로 (Fiddler·TLS 디버깅용) */
function formatFetchError(err) {
  const parts = [err && err.message ? err.message : String(err)];
  let c = err && err.cause;
  for (let i = 0; c && i < 6; i++) {
    const m = c.message || String(c);
    if (m && !parts.includes(m)) parts.push(m);
    c = c.cause;
  }
  return parts.join(" | ");
}

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

/* ─────────────────── EverSafe / VM script (Node-side) ─────────────────── */

function getEverSafeScriptPath() {
  const p = (process.env.EVERSAFE_TXT_PATH || "").trim();
  return p ? path.resolve(p) : path.join(__dirname, "EverSafe.txt");
}

/** `/session/evaluate` 의 `vmLoadBaseUrl` 사용 시 네트워크 대신 이 파일 내용을 주입 */
async function readEverSafeVmScript() {
  const resolvedPath = getEverSafeScriptPath();
  let scriptText;
  try {
    scriptText = await fsp.readFile(resolvedPath, "utf8");
  } catch (e) {
    throw new Error(`EverSafe VM 스크립트를 읽을 수 없습니다 (${resolvedPath}): ${e.message}`);
  }
  if (!String(scriptText).trim()) {
    throw new Error(`EverSafe VM 스크립트가 비어 있습니다: ${resolvedPath}`);
  }
  return { scriptText, resolvedPath };
}

/** 테스트·기타: URL에서 스크립트 다운로드 (쿠키 포함) */
async function fetchVmScript(baseUrl, page) {
  const sep = baseUrl.includes("?") ? "&" : "?";
  const fullUrl = `${baseUrl}${sep}t=${Date.now()}`;

  const cookies = await page.cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  let res;
  try {
    res = await fetch(fullUrl, {
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
    });
  } catch (e) {
    const detail = formatFetchError(e);
    const tlsHint =
      /certificate|SSL|TLS|UNABLE_TO_VERIFY|self-signed|cert/i.test(detail) &&
      process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0"
        ? " [Fiddler 등 HTTPS 가로채기 시: 같은 세션에서 $env:NODE_TLS_REJECT_UNAUTHORIZED='0' (개발 전용) 후 서버 재시작]"
        : "";
    throw new Error(`VM script fetch failed: ${detail}${tlsHint}`);
  }
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
          var trimmed = (raw || '').trim();
          if (respCT.includes('json')) {
            try { data = JSON.parse(raw); } catch(_) { data = raw.substring(0, 2000); }
          } else if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
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

/**
 * 난독화 스크립트보다 먼저 실행되도록 eval 문자열 앞에 붙임(prepend).
 * 서버의 navigation 정책(차단·허용 접두)과 동일한 규칙으로 history / Location 을 한 번 더 막음.
 * ※ 동기적으로 즉시 실행되는 location 변경은 가드 이후에 오는 코드에서만 효과가 있음(난독화 본문이 먼저면 막지 못함 → 반드시 prepend).
 */
function buildVmNavigationGuardPrefixString(blocked, allowed) {
  const B = JSON.stringify(blocked || []);
  const A = JSON.stringify(allowed || []);
  return `;(function(){
var __B=${B},__A=${A};
function __navVmBad(u){
  if(u==null||u==="")return false;
  var abs;
  try{abs=new URL(String(u),location.href).href}catch(_){return false}
  for(var i=0;i<__B.length;i++){if(abs.startsWith(__B[i]))return true}
  if(__A.length>0&&!__A.some(function(x){return abs.startsWith(x)}))return true;
  return false;
}
try{
  var __hp=history.pushState.bind(history),__hr=history.replaceState.bind(history);
  history.pushState=function(s,t,u){if(__navVmBad(u))return;return __hp.apply(history,arguments)};
  history.replaceState=function(s,t,u){if(__navVmBad(u))return;return __hr.apply(history,arguments)};
}catch(_){}
try{
  var __la=Location.prototype.assign,__lr=Location.prototype.replace;
  Location.prototype.assign=function(u){if(__navVmBad(u))return;return __la.call(this,u)};
  Location.prototype.replace=function(u){if(__navVmBad(u))return;return __lr.call(this,u)};
}catch(_){}
try{
  var __d=Object.getOwnPropertyDescriptor(Location.prototype,"href");
  if(__d&&__d.set){
    var __os=__d.set;
    __d.set=function(v){if(__navVmBad(v))return;return __os.call(this,v)};
    Object.defineProperty(Location.prototype,"href",__d);
  }
}catch(_){}
try{
  document.addEventListener("click",function(e){
    var a=e.target&&e.target.closest&&e.target.closest("a[href]");
    if(a&&__navVmBad(a.href)){e.preventDefault();e.stopPropagation();}
  },true);
  document.addEventListener("submit",function(e){
    var t=e.target;
    if(t&&t.action&&__navVmBad(String(t.action))){e.preventDefault();}
  },true);
  var __wo=window.open;
  window.open=function(){
    if(arguments.length&&__navVmBad(String(arguments[0])))return null;
    return __wo.apply(window,arguments);
  };
}catch(_){}
})();`;
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
    const { scriptText, resolvedPath } = await readEverSafeVmScript();
    const vmPrependNavigationGuard = body.vmPrependNavigationGuard !== false;
    let blocked = pageNavigationBlockedPrefixes.get(page) || [];
    let allowed = pageNavigationAllowedPrefixes.get(page) || [];
    const g = body.vmNavigationGuard;
    if (g && typeof g === "object") {
      if (Array.isArray(g.blocked)) blocked = normalizeNavigationPrefixList(g.blocked);
      if (Array.isArray(g.allowed)) allowed = normalizeNavigationPrefixList(g.allowed);
      if (g.autoAllowCurrentPagePrefix === true) {
        const ap = autoNavigationAllowPrefixFromPageUrl(await page.url());
        if (ap && !allowed.some((x) => x === ap)) allowed = [ap, ...allowed];
      }
    }
    if (g && typeof g === "object" && g.autoAllowCurrentPagePrefix === true && allowed.length) {
      await applyNavigationPolicy(page, undefined, allowed);
    }
    let combined = scriptText;
    let guardLen = 0;
    if (vmPrependNavigationGuard && (blocked.length || allowed.length)) {
      const guard = buildVmNavigationGuardPrefixString(blocked, allowed);
      guardLen = guard.length;
      combined = `${guard}\n${scriptText}`;
    }
    await page.evaluate((src) => {
      eval(src);
    }, combined);
    if (body.vmRememberLoadUrlForRestore !== false) {
      pageLastVmLoadBaseUrl.set(page, vmLoadBaseUrl);
    }
    vmResult = {
      ok: true,
      source: "EverSafe.txt",
      path: resolvedPath,
      vmLoadBaseUrl,
      len: combined.length,
      vmLen: scriptText.length,
      guardLen,
    };
  }

  const settle = Number(body.postVmSettleMs);
  if (vmResult && targetUrl && payload !== undefined && Number.isFinite(settle) && settle > 0) {
    await sleep(Math.min(settle, 10_000));
  }

  let xhrResult;
  if (targetUrl && payload !== undefined) {
    const code = buildXhrPostCode(targetUrl, payload, contentType);
    xhrResult = await page.evaluate(code);
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
    await applyNavigationPolicy(page, navigationBlockedUrlPrefixes, navigationAllowedUrlPrefixes);
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

/* ─── Session: evaluate ─── */

app.post("/session/evaluate", async (req, res) => {
  try {
    const { sessionId, timeout } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    const sess = sessions.get(sessionId);
    if (!sess) return res.status(404).json({ error: "session not found" });
    touchSession(sessionId);

    await applyNavigationPolicy(
      sess.page,
      req.body && req.body.navigationBlockedUrlPrefixes,
      req.body && req.body.navigationAllowedUrlPrefixes,
    );

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
    await applyNavigationPolicy(
      page,
      req.body && req.body.navigationBlockedUrlPrefixes,
      req.body && req.body.navigationAllowedUrlPrefixes,
    );
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