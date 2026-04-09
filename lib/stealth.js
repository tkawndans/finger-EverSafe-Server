/** Puppeteer 페이지 자동화 흔적 완화 (헤더·UA·evaluateOnNewDocument) */

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

function parseChromeVersionFromBrowserStrings(versionLine, fallbackFull = "131.0.0.0") {
  const m = versionLine && versionLine.match(/\/([\d.]+)/);
  const fullVersion = m ? m[1] : fallbackFull;
  const major = fullVersion.split(".")[0] || "131";
  return { fullVersion, major };
}

async function applyStealthUserAgent(page, browserInstance) {
  const rawUa = await browserInstance.userAgent();
  const verLine = await browserInstance.version();
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

async function applyPageStealth(page, browserInstance) {
  if (!STEALTH_ENABLED) return;

  await applyStealthUserAgent(page, browserInstance);

  const langList = (process.env.PUPPETEER_NAVIGATOR_LANGUAGES || "ko-KR,ko,en-US,en")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  await installStealthInitScript(page, langList);
  await page.setExtraHTTPHeaders(mergeStealthHeaders());
}

module.exports = {
  STEALTH_ENABLED,
  mergeStealthHeaders,
  applyPageStealth,
};
