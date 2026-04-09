const {
  isUrlCompliantWithNavigationPolicy,
} = require("./urlPrefixMatch");
const vmScript = require("./vmScript");

const pageNavigationBlockedPrefixes = new WeakMap();
const pageNavigationAllowedPrefixes = new WeakMap();
const pageLastAllowedMainFrameUrl = new WeakMap();
const pageLastVmLoadBaseUrl = new WeakMap();

const VM_REINJECT_AFTER_RESTORE = process.env.PUPPETEER_NO_VM_REINJECT_AFTER_RESTORE !== "1";

function normalizeNavigationPrefixList(input) {
  if (!Array.isArray(input)) return [];
  return input.map((s) => String(s).trim()).filter(Boolean);
}

function getLists(page) {
  return {
    allowed: pageNavigationAllowedPrefixes.get(page) || [],
    blocked: pageNavigationBlockedPrefixes.get(page) || [],
  };
}

/** 현재 페이지 URL의 디렉터리 접두 — 화이트리스트 자동 구성용 */
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

function shouldAbortMainFrameNavigation(req, page) {
  const u = req.url();
  const { allowed, blocked } = getLists(page);
  return isMainFrameDocumentNavigation(req, page) && !isUrlCompliantWithNavigationPolicy(u, allowed, blocked);
}

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

function rememberVmLoadUrlForPage(page, vmLoadBaseUrl) {
  pageLastVmLoadBaseUrl.set(page, vmLoadBaseUrl);
}

function recordCompliantUrlAfterGoto(page, finalUrl) {
  const { allowed, blocked } = getLists(page);
  if (isUrlCompliantWithNavigationPolicy(finalUrl, allowed, blocked)) {
    pageLastAllowedMainFrameUrl.set(page, finalUrl);
  }
}

async function reinjectVmScriptAfterRestore(page) {
  if (!pageLastVmLoadBaseUrl.get(page) || !VM_REINJECT_AFTER_RESTORE) return;
  const { scriptText } = await vmScript.readEverSafeVmScript();
  const { allowed, blocked } = getLists(page);
  const { combined } = vmScript.combineScriptWithOptionalGuard(scriptText, blocked, allowed, true);
  await vmScript.evalVmScriptInPage(page, combined);
}

async function restoreMainFrameIfNavigationPolicyViolated(page) {
  let u = "";
  try {
    u = page.url();
  } catch (_) {
    return;
  }
  const { allowed, blocked } = getLists(page);
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
    let url = "";
    try {
      url = page.url();
    } catch (_) {
      return;
    }
    const { allowed, blocked } = getLists(page);
    if (isUrlCompliantWithNavigationPolicy(url, allowed, blocked)) {
      pageLastAllowedMainFrameUrl.set(page, url);
    } else {
      void runRestore();
    }
  });

  page.on("requestfailed", (request) => {
    if (!request.isNavigationRequest()) return;
    const url = request.url();
    const { allowed, blocked } = getLists(page);
    if (isUrlCompliantWithNavigationPolicy(url, allowed, blocked)) return;
    void runRestore();
  });

  page.on("load", () => {
    void runRestore();
  });
}

module.exports = {
  normalizeNavigationPrefixList,
  autoNavigationAllowPrefixFromPageUrl,
  applyNavigationPolicy,
  attachNavigationBlockRecovery,
  shouldAbortMainFrameNavigation,
  rememberVmLoadUrlForPage,
  recordCompliantUrlAfterGoto,
  getLists,
};
