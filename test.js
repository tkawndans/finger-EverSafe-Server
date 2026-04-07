/**
 * 테스트 전용: GET /test (test/testPage.html)
 * 운영에서 비활성화: ENABLE_TEST_PAGE=0 node server.js
 */
const fs = require("fs");
const path = require("path");

const IDENT_RE = /^[a-zA-Z_$][\w$]*$/;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 스크립트 상단에서 전역 설정 객체 이름 후보 (NKmkj 등) */
function detectConfigGlobalFromHeader(scriptText, headLen = 65536) {
  const head = scriptText.slice(0, Math.min(headLen, scriptText.length));
  const patterns = [
    /if\s*\(\s*!window\.(\w+)\s*\)/,
    /if\s*\(\s*!window\[\s*['"](\w+)['"]\s*\]\s*\)/,
    /typeof\s+window\.(\w+)\s*===\s*['"]undefined['"]/,
    /typeof\s+window\[['"](\w+)['"]\]\s*===\s*['"]undefined['"]/,
  ];
  for (const re of patterns) {
    const m = head.match(re);
    if (m && IDENT_RE.test(m[1])) return m[1];
  }
  return null;
}

/** `}` 위치에서 매칭되는 `{` 인덱스 (문자열/주석 미처리 — 일반 난독화 스크립트용) */
function findMatchingOpenBrace(text, closeIdx) {
  if (closeIdx < 0 || closeIdx >= text.length || text[closeIdx] !== "}") return null;
  let depth = 1;
  for (let i = closeIdx - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "}") depth++;
    else if (c === "{") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * `}(G),` 직전 IIFE: `binding = function name(...) { ... }(G),` 에서 binding 추출
 */
function extractBindingNameBeforeBrace(text, openBraceIdx) {
  const before = text.slice(0, openBraceIdx);
  const re = /\b(\w+)\s*=\s*function\s+\w+\s*\(/g;
  let last = null;
  let m;
  while ((m = re.exec(before)) !== null) last = m;
  return last && IDENT_RE.test(last[1]) ? last[1] : null;
}

/**
 * needle: \}\s*\(\s*G\s*\)\s*,  첫 번째 `}` = IIFE 본문을 닫는 `}`
 */
function tryInjectAtNeedle(scriptText, G) {
  const re = new RegExp(`\\}\\s*\\(\\s*${escapeRegExp(G)}\\s*\\)\\s*,`);
  const m = re.exec(scriptText);
  if (!m) return { ok: false, reason: "needle_not_found", G };

  const closeBraceIdx = m.index;
  const openBrace = findMatchingOpenBrace(scriptText, closeBraceIdx);
  if (openBrace == null) return { ok: false, reason: "brace_match_failed", G };

  const binding = extractBindingNameBeforeBrace(scriptText, openBrace);
  if (!binding) return { ok: false, reason: "binding_not_found", G };

  const insert =
    m[0] +
    `window.__EVERSAFE_UT_EXTRACT__=(function(){try{return ${binding}&&${binding}.u?{u:${binding}.u,t:${binding}.u.t}:null}catch(e){return{error:String(e.message)}}})(),`;
  const injected = scriptText.slice(0, m.index) + insert + scriptText.slice(m.index + m[0].length);

  return {
    ok: true,
    injected,
    detect: {
      configGlobal: G,
      bindingName: binding,
      needleMatchIndex: m.index,
      needleMatchLength: m[0].length,
    },
  };
}

/**
 * G를 헤더에서 못 찾은 경우: `}(이름),` 패턴 후보를 수집해, 헤더에 `window.이름` 이 있으면 우선
 */
function collectGFromIifeCalls(scriptText, headLen = 65536) {
  const head = scriptText.slice(0, Math.min(headLen, scriptText.length));
  const re = /\}\s*\(\s*([a-zA-Z_$][\w$]*)\s*\)\s*,/g;
  const seen = new Map();
  let mm;
  while ((mm = re.exec(scriptText)) !== null) {
    const G = mm[1];
    if (!IDENT_RE.test(G)) continue;
    if (!seen.has(G)) seen.set(G, mm.index);
  }
  const list = [...seen.entries()].map(([G, index]) => ({ G, index }));
  list.sort((a, b) => {
    const aWin = new RegExp(`(?:window\\.${escapeRegExp(a.G)}|!window\\.${escapeRegExp(a.G)})`).test(head);
    const bWin = new RegExp(`(?:window\\.${escapeRegExp(b.G)}|!window\\.${escapeRegExp(b.G)})`).test(head);
    if (aWin !== bWin) return aWin ? -1 : 1;
    return a.index - b.index;
  });
  return list.map((x) => x.G);
}

/**
 * 단계적 탐지: 설정 전역 G → needle → binding → 삽입
 */
function injectUtExtractor(scriptText) {
  const steps = [];

  const G1 = detectConfigGlobalFromHeader(scriptText);
  if (G1) {
    steps.push({ step: "header_config_global", value: G1 });
    const r1 = tryInjectAtNeedle(scriptText, G1);
    if (r1.ok) return { ok: true, ...r1, steps };
    steps.push({ step: "try_header_G", G: G1, fail: r1.reason });
  } else {
    steps.push({ step: "header_config_global", value: null });
  }

  const candidates = collectGFromIifeCalls(scriptText);
  steps.push({ step: "iife_call_candidates", count: candidates.length, sample: candidates.slice(0, 12) });

  for (const G of candidates) {
    const r = tryInjectAtNeedle(scriptText, G);
    if (r.ok) return { ok: true, ...r, steps };
    steps.push({ step: "try_candidate", G, fail: r.reason });
  }

  return { ok: false, reason: "all_candidates_failed", steps };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function registerTestRoutes(app, deps = {}) {
  const htmlPath = path.join(__dirname, "test", "testPage.html");

  app.get("/test", (_req, res) => {
    try {
      const html = fs.readFileSync(htmlPath, "utf8");
      res.type("html").send(html);
    } catch (e) {
      res.status(500).send("Test page file missing: " + htmlPath);
    }
  });

  /**
   * POST /test/extract-ut
   * Body: { createUrl?, vmLoadBaseUrl, timeout?, waitUntilUrlContains? }
   * ① createUrl → goto (쿠키·세션), ② vmLoadBaseUrl → 보안 스크립트 fetch 후 eval + binding.u / binding.u.t 추출
   */
  app.post("/test/extract-ut", async (req, res) => {
    const { createPage, fetchVmScript, gotoAndWait } = deps;
    if (!createPage || !fetchVmScript || !gotoAndWait) {
      return res.status(500).json({ error: "test routes missing server deps (createPage, fetchVmScript, gotoAndWait)" });
    }

    const { createUrl, vmLoadBaseUrl, waitUntilUrlContains } = req.body || {};
    const timeout = Number(req.body && req.body.timeout) || 60_000;

    if (!vmLoadBaseUrl || typeof vmLoadBaseUrl !== "string") {
      return res.status(400).json({ error: "vmLoadBaseUrl required" });
    }

    let page;
    try {
      page = await createPage();
      const trimmedCreate = typeof createUrl === "string" ? createUrl.trim() : "";
      if (trimmedCreate) {
        await gotoAndWait(page, trimmedCreate, {
          timeout,
          waitUntilUrlContains: typeof waitUntilUrlContains === "string" ? waitUntilUrlContains.trim() || undefined : undefined,
        });
      }

      const { scriptText, fullUrl } = await fetchVmScript(vmLoadBaseUrl, page);
      const inj = injectUtExtractor(scriptText);
      if (!inj.ok) {
        return res.status(422).json({
          error: "inject_failed",
          reason: inj.reason,
          steps: inj.steps,
          hint:
            "전역 설정명·IIFE 인자·binding 추출에 실패했습니다. 스크립트 구조가 크게 바뀌었거나 문자열 안에 `}` 가 섞이면 brace 매칭이 틀릴 수 있습니다.",
          vmFetchUrl: fullUrl,
          scriptLen: scriptText.length,
        });
      }

      await page.evaluate((src) => {
        eval(src);
      }, inj.injected);

      await sleep(0);

      const extracted = await page.evaluate(() => {
        try {
          return window.__EVERSAFE_UT_EXTRACT__ != null ? window.__EVERSAFE_UT_EXTRACT__ : null;
        } catch (e) {
          return { error: String(e && e.message ? e.message : e) };
        }
      });

      let tVal;
      let uVal;
      if (extracted && typeof extracted === "object" && !Array.isArray(extracted)) {
        if ("error" in extracted && extracted.error) {
          return res.json({
            ok: false,
            step: "runtime_extract",
            error: extracted.error,
            detect: inj.detect,
            steps: inj.steps,
            vmFetchUrl: fullUrl,
            scriptLen: scriptText.length,
            finalUrl: page.url(),
          });
        }
        tVal = extracted.t;
        uVal = extracted.u;
      } else {
        tVal = extracted;
      }

      let uJson;
      try {
        uJson = uVal !== undefined ? JSON.parse(JSON.stringify(uVal)) : undefined;
      } catch (e) {
        uJson = { _serializeError: String(e.message || e), _preview: String(uVal).slice(0, 2000) };
      }

      res.json({
        ok: true,
        t: typeof tVal === "string" ? tVal : tVal != null ? String(tVal) : null,
        u: uJson !== undefined ? uJson : null,
        detect: inj.detect,
        steps: inj.steps,
        vmFetchUrl: fullUrl,
        scriptLen: scriptText.length,
        finalUrl: page.url(),
      });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    } finally {
      if (page) await page.close().catch(() => {});
    }
  });
}

module.exports = registerTestRoutes;
