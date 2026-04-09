const nav = require("./navigationPolicy");
const { executeOnPage } = require("./evaluate");

function parseComma(s) {
  if (!s || !String(s).trim()) return [];
  return String(s).split(",").map((x) => x.trim()).filter(Boolean);
}

/**
 * WARM_START_URL 이 있으면 웜 활성. 나머지는 선택.
 */
function getWarmConfig() {
  const startUrl = (process.env.WARM_START_URL || "").trim();
  if (!startUrl) return { enabled: false };

  let vmLoadBaseUrl = (process.env.WARM_VM_LOAD_BASE_URL || "").trim();
  if (!vmLoadBaseUrl) {
    try {
      const u = new URL(startUrl);
      const path = u.pathname;
      const lastSlash = path.lastIndexOf("/");
      const dir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "/";
      vmLoadBaseUrl = u.origin + dir;
    } catch {
      vmLoadBaseUrl = startUrl;
    }
  }

  const blocked = parseComma(process.env.WARM_NAVIGATION_BLOCKED_URL_PREFIXES);
  const allowed = parseComma(process.env.WARM_NAVIGATION_ALLOWED_URL_PREFIXES);

  let headers = {};
  const hj = (process.env.WARM_EXTRA_HEADERS_JSON || "").trim();
  if (hj) {
    try {
      headers = JSON.parse(hj);
      if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
        throw new Error("must be a JSON object");
      }
    } catch (e) {
      throw new Error(`WARM_EXTRA_HEADERS_JSON: ${e.message}`);
    }
  }

  let vmNavigationGuard;
  const ng = (process.env.WARM_VM_NAVIGATION_GUARD_JSON || "").trim();
  if (ng) {
    try {
      vmNavigationGuard = JSON.parse(ng);
    } catch (e) {
      throw new Error(`WARM_VM_NAVIGATION_GUARD_JSON: ${e.message}`);
    }
  }

  const timeoutRaw = parseInt(process.env.WARM_GOTO_TIMEOUT_MS || "60000", 10);
  const timeout = Number.isFinite(timeoutRaw)
    ? Math.min(Math.max(timeoutRaw, 5000), 600000)
    : 60000;

  const extractTnkSrWaitMs = parseInt(process.env.WARM_EXTRACT_TNK_SR_WAIT_MS || "0", 10);

  return {
    enabled: true,
    startUrl,
    vmLoadBaseUrl,
    blocked: blocked.length ? blocked : undefined,
    allowed: allowed.length ? allowed : undefined,
    headers,
    timeout,
    cookies: (process.env.WARM_COOKIES || "").trim() || undefined,
    waitUntilUrlContains: (process.env.WARM_WAIT_UNTIL_URL_CONTAINS || "").trim() || undefined,
    extractTnkSr: process.env.WARM_EXTRACT_TNK_SR === "1",
    extractTnkSrWaitMs: Number.isFinite(extractTnkSrWaitMs) ? Math.min(Math.max(extractTnkSrWaitMs, 0), 60_000) : 0,
    vmNavigationGuard,
  };
}

let warmPage = null;
let warmReady = false;
let warmLastError = null;
let warmSetupInFlight = false;
let lockChain = Promise.resolve();

function getState() {
  let cfg;
  try {
    cfg = getWarmConfig();
  } catch (e) {
    return {
      warmEnabled: false,
      warmReady: false,
      warmLastError: e.message || String(e),
      warmSetupInFlight,
      warmUrl: null,
      warmConfigError: true,
    };
  }
  return {
    warmEnabled: cfg.enabled,
    warmReady: cfg.enabled ? warmReady : false,
    warmLastError,
    warmSetupInFlight,
    warmUrl: cfg.enabled ? cfg.startUrl : null,
  };
}

function detachWarmPage() {
  warmPage = null;
  warmReady = false;
}

/** 의도적 브라우저 종료·재시작 직전 */
function detachWarmPageOnly() {
  detachWarmPage();
}

/** 크래시 등으로 브라우저 연결 끊김 */
function onBrowserDisconnected() {
  warmPage = null;
  warmReady = false;
  warmLastError = warmLastError || "browser disconnected";
}

async function closeWarmPageSafe() {
  if (warmPage) {
    try {
      await warmPage.close();
    } catch (_) {
      /* page may already be dead */
    }
    warmPage = null;
  }
  warmReady = false;
}

function withLock(fn) {
  const p = lockChain.then(() => fn());
  lockChain = p.catch(() => {});
  return p;
}

/**
 * @param {object} deps
 * @param {() => Promise<import('puppeteer').Page>} deps.createPage
 * @param {function} deps.gotoAndWait
 * @param {function} deps.sleep
 * @param {function} deps.extractTnkSrFromPage
 */
async function setupWarm(deps) {
  let cfg;
  try {
    cfg = getWarmConfig();
  } catch (e) {
    const msg = e.message || String(e);
    warmLastError = msg;
    console.error("[warm] config error:", msg);
    return { ok: false, error: msg };
  }

  if (!cfg.enabled) {
    console.log("[warm] skipped (WARM_START_URL unset)");
    return { ok: false, skipped: true };
  }

  if (warmSetupInFlight) {
    console.log("[warm] setup already in flight — skip duplicate");
    return { ok: false, busy: true };
  }

  warmSetupInFlight = true;
  warmLastError = null;
  warmReady = false;

  try {
    await closeWarmPageSafe();

    const { createPage, gotoAndWait, sleep, extractTnkSrFromPage } = deps;
    const page = await createPage();
    warmPage = page;

    await nav.applyNavigationPolicy(page, cfg.blocked, cfg.allowed);

    console.log(`[warm] navigating: ${cfg.startUrl}`);
    await gotoAndWait(page, cfg.startUrl, {
      cookies: cfg.cookies,
      headers: Object.keys(cfg.headers).length ? cfg.headers : undefined,
      timeout: cfg.timeout,
      waitUntilUrlContains: cfg.waitUntilUrlContains,
    });

    if (cfg.extractTnkSr) {
      const w = cfg.extractTnkSrWaitMs;
      if (w > 0) await sleep(w);
      const tnk = await extractTnkSrFromPage(page).catch(() => null);
      if (tnk != null) console.log(`[warm] TNK_SR (preview): ${String(tnk).slice(0, 80)}…`);
    }

    const runBody = {
      vmLoadBaseUrl: cfg.vmLoadBaseUrl,
      vmPrependNavigationGuard: deps.vmPrependNavigationGuard !== false,
    };
    if (cfg.vmNavigationGuard && typeof cfg.vmNavigationGuard === "object") {
      runBody.vmNavigationGuard = cfg.vmNavigationGuard;
    }

    await executeOnPage(page, runBody, cfg.timeout, { gotoAndWait });

    warmReady = true;
    warmLastError = null;
    console.log("[warm] ready (VM injected):", cfg.startUrl);
    return { ok: true };
  } catch (e) {
    warmLastError = e.message || String(e);
    console.error("[warm] setup failed:", warmLastError);
    await closeWarmPageSafe();
    return { ok: false, error: warmLastError };
  } finally {
    warmSetupInFlight = false;
  }
}

function setupWarmLocked(deps) {
  return withLock(() => setupWarm(deps));
}

/**
 * POST /evaluate/warm — 이미 VM이 올라간 웜 페이지에서 XHR 단계(③)만 실행.
 */
async function evaluateWarm(body, timeout, deps) {
  return withLock(async () => {
    let cfg;
    try {
      cfg = getWarmConfig();
    } catch (e) {
      throw new Error(e.message || String(e));
    }
    if (!cfg.enabled) throw new Error("warm is not enabled (set WARM_START_URL)");
    if (!warmReady || !warmPage) {
      throw new Error("warm page is not ready; check warmLastError or POST /warm/retry");
    }
    const b = body && typeof body === "object" ? body : {};
    if (b.url) throw new Error("evaluate/warm does not accept url — use targetUrl + payload only");
    if (b.vmLoadBaseUrl) throw new Error("evaluate/warm does not accept vmLoadBaseUrl");

    const { gotoAndWait } = deps;
    return executeOnPage(warmPage, b, timeout || 30_000, { gotoAndWait });
  });
}

async function getWarmPageUrl() {
  if (!warmPage) return null;
  try {
    return warmPage.url();
  } catch {
    return null;
  }
}

module.exports = {
  getWarmConfig,
  getState,
  getWarmPageUrl,
  setupWarm,
  setupWarmLocked,
  evaluateWarm,
  detachWarmPageOnly,
  onBrowserDisconnected,
  closeWarmPageSafe,
  withLock,
};
