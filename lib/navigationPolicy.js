const {
  isUrlCompliantWithNavigationPolicy,
} = require("./urlPrefixMatch");
const vmScript = require("./vmScript");

const pageNavigationBlockedPrefixes = new WeakMap();
const pageNavigationAllowedPrefixes = new WeakMap();
/** WARM_LOCK_TO_START_URL: 메인 프레임 문서 요청은 이 정규화 `href`와 일치할 때만 허용 */
const pageExactNavigationLockUrl = new WeakMap();
/** 락 모드 + 초기 goto 1회 성공 후 — 이후 모든 메인 프레임 네비게이션 요청 abort */
const pageExactLockInitialGotoDone = new WeakMap();
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

function normalizeUrlHref(s) {
  try {
    return new URL(String(s).trim()).href;
  } catch (_) {
    return String(s == null ? "" : s).trim();
  }
}

function getExactNavigationLockUrl(page) {
  return pageExactNavigationLockUrl.get(page) || "";
}

function isExactNavigationLockActive(page) {
  return !!pageExactNavigationLockUrl.get(page);
}

function shouldAbortMainFrameNavigation(req, page) {
  if (!isMainFrameDocumentNavigation(req, page)) return false;
  const exact = pageExactNavigationLockUrl.get(page);
  if (exact) {
    /**
     * 초기 goto 1회 성공 이후에는 URL 이 같든 다르든 모두 abort.
     * (window.location = url / location.reload() / 서버 302 등으로 인한 second-hit 방지)
     */
    if (pageExactLockInitialGotoDone.get(page) === true) return true;
    return normalizeUrlHref(req.url()) !== exact;
  }
  const u = req.url();
  const { allowed, blocked } = getLists(page);
  return !isUrlCompliantWithNavigationPolicy(u, allowed, blocked);
}

async function applyNavigationPolicy(
  page,
  navigationBlockedUrlPrefixes,
  navigationAllowedUrlPrefixes,
  exactNavigationLockStartUrl
) {
  if (exactNavigationLockStartUrl != null && String(exactNavigationLockStartUrl).trim()) {
    pageExactNavigationLockUrl.set(page, normalizeUrlHref(exactNavigationLockStartUrl));
  } else {
    pageExactNavigationLockUrl.delete(page);
  }
  pageExactLockInitialGotoDone.delete(page);

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
  const exactLockHref = pageExactNavigationLockUrl.get(page) || "";

  await page.evaluateOnNewDocument((cfg) => {
    window.__NAV_BLOCK_PREFIXES__ = cfg.blocked.slice();
    window.__NAV_ALLOW_PREFIXES__ = cfg.allowed.slice();
    window.__NAV_EXACT_LOCK_HREF__ = cfg.exactLockHref || "";
    if (window.__navPolicyPatched) return;
    window.__navPolicyPatched = true;

    const isLock = !!window.__NAV_EXACT_LOCK_HREF__;

    const navDisallowed = (urlArg) => {
      const ex = window.__NAV_EXACT_LOCK_HREF__;
      /**
       * 락 모드: JS 가 시도하는 모든 메인 네비게이션 무시. (초기 page.goto 는 CDP 경로라 영향 없음.)
       * 같은 URL(reload 류)도 막아야 — 서버가 second-hit 에 302 로 다른 URL 을 줄 수 있음.
       */
      if (ex) return true;
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

    /**
     * 락 모드에선 VM 이 다시 원본을 할당하지 못하도록 non-configurable + non-writable 로 잠금.
     * 비-락 모드에선 기본 단순 할당(다른 페이지 호환성 위해).
     */
    const defineMethod = (target, name, value) => {
      if (!isLock) {
        try { target[name] = value; } catch (_) { /* ignore */ }
        return;
      }
      try {
        Object.defineProperty(target, name, {
          value,
          writable: false,
          configurable: false,
          enumerable: false,
        });
      } catch (_) {
        try { target[name] = value; } catch (_e) { /* ignore */ }
      }
    };

    const origPush = history.pushState.bind(history);
    const origReplaceState = history.replaceState.bind(history);
    defineMethod(history, "pushState", function (state, title, url) {
      if (navDisallowed(url)) return;
      return origPush(state, title, url);
    });
    defineMethod(history, "replaceState", function (state, title, url) {
      if (navDisallowed(url)) return;
      return origReplaceState(state, title, url);
    });

    try {
      const oa = Location.prototype.assign;
      const or = Location.prototype.replace;
      defineMethod(Location.prototype, "assign", function (url) {
        if (navDisallowed(url)) return;
        return oa.call(this, url);
      });
      defineMethod(Location.prototype, "replace", function (url) {
        if (navDisallowed(url)) return;
        return or.call(this, url);
      });
      const __hrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, "href");
      if (__hrefDesc && __hrefDesc.set) {
        const __origHrefGet = __hrefDesc.get;
        const __origHrefSet = __hrefDesc.set;
        try {
          Object.defineProperty(Location.prototype, "href", {
            configurable: !isLock,
            enumerable: true,
            get: function () { return __origHrefGet.call(this); },
            set: function (v) {
              if (navDisallowed(v)) return;
              return __origHrefSet.call(this, v);
            },
          });
        } catch (_) {
          /* ignore */
        }
      }
    } catch (_) {
      /* ignore */
    }

    if (isLock) {
      try {
        const stripMetaRefresh = () => {
          const metas = document.getElementsByTagName("meta");
          for (let i = metas.length - 1; i >= 0; i--) {
            const he = metas[i].getAttribute("http-equiv");
            if (he && /^\s*refresh\s*$/i.test(String(he))) metas[i].remove();
          }
        };
        stripMetaRefresh();
        if (typeof MutationObserver !== "undefined" && document.documentElement) {
          new MutationObserver(stripMetaRefresh).observe(document.documentElement, {
            childList: true,
            subtree: true,
          });
        }
      } catch (_) {
        /* ignore */
      }

      try {
        defineMethod(Location.prototype, "reload", function () {
          /** 락 모드: reload 자체 무시. 서버가 second-hit 에 302 로 다른 URL 을 주면 파기됨. */
          return undefined;
        });
      } catch (_) {
        /* ignore */
      }

      try {
        const __origSubmit = HTMLFormElement.prototype.submit;
        defineMethod(HTMLFormElement.prototype, "submit", function () {
          try {
            const tgt = (this.target || "").toLowerCase();
            if (tgt === "" || tgt === "_self" || tgt === "_top") {
              const action = this.action || location.href;
              if (navDisallowed(action)) return;
            }
          } catch (_) {
            /* ignore */
          }
          return __origSubmit.apply(this, arguments);
        });
      } catch (_) {
        /* ignore */
      }

      try {
        const __origOpen = window.open;
        defineMethod(window, "open", function (url, target) {
          try {
            const tgt = (target || "_blank").toLowerCase();
            if (tgt === "_self" || tgt === "_top" || tgt === "_parent") {
              if (navDisallowed(url)) return null;
            }
          } catch (_) {
            /* ignore */
          }
          return __origOpen.apply(window, arguments);
        });
      } catch (_) {
        /* ignore */
      }
    }
  }, { blocked, allowed, exactLockHref });

  try {
    await page.evaluate((cfg) => {
      window.__NAV_BLOCK_PREFIXES__ = cfg.blocked.slice();
      window.__NAV_ALLOW_PREFIXES__ = cfg.allowed.slice();
      window.__NAV_EXACT_LOCK_HREF__ = cfg.exactLockHref || "";
    }, { blocked, allowed, exactLockHref });
  } catch (_) {
    /* ignore */
  }
}

function rememberVmLoadUrlForPage(page, vmLoadBaseUrl) {
  pageLastVmLoadBaseUrl.set(page, vmLoadBaseUrl);
}

function recordCompliantUrlAfterGoto(page, finalUrl) {
  const exact = pageExactNavigationLockUrl.get(page);
  if (exact) {
    if (normalizeUrlHref(finalUrl) === exact) {
      pageLastAllowedMainFrameUrl.set(page, finalUrl);
      /** 락 모드: 이후 모든 메인 네비 차단 모드로 전환 */
      pageExactLockInitialGotoDone.set(page, true);
    }
    return;
  }
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
  /** 락 모드에서는 “원천 차단” 정책 — 잠깐 갔다가 돌아오는 복구 동작 없음 */
  if (pageExactNavigationLockUrl.has(page)) return;
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
  getExactNavigationLockUrl,
  isExactNavigationLockActive,
};
