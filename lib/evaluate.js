const vmScript = require("./vmScript");
const nav = require("./navigationPolicy");
const xhrCapture = require("./xhrCapture");

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function executeOnPage(page, body, timeout, deps = {}) {
  const { gotoAndWait } = deps;
  const { vmLoadBaseUrl, targetUrl, payload, contentType } = body;
  if (!vmLoadBaseUrl && !(targetUrl && payload !== undefined)) {
    throw new Error("vmLoadBaseUrl 또는 targetUrl+payload 중 하나는 필수입니다");
  }

  if (body.url) {
    if (typeof gotoAndWait !== "function") {
      throw new Error("body.url 이 있을 때 gotoAndWait 이 필요합니다");
    }
    await gotoAndWait(page, body.url, {
      timeout,
      waitUntilUrlContains: body.waitUntilUrlContains,
    });
  }

  let vmResult;
  if (vmLoadBaseUrl) {
    const { scriptText, resolvedPath } = await vmScript.readEverSafeVmScript();
    const vmPrependNavigationGuard = body.vmPrependNavigationGuard !== false;
    const lists = nav.getLists(page);
    let blocked = lists.blocked;
    let allowed = lists.allowed;
    const g = body.vmNavigationGuard;
    if (g && typeof g === "object") {
      if (Array.isArray(g.blocked)) blocked = nav.normalizeNavigationPrefixList(g.blocked);
      if (Array.isArray(g.allowed)) allowed = nav.normalizeNavigationPrefixList(g.allowed);
      if (g.autoAllowCurrentPagePrefix === true) {
        const ap = nav.autoNavigationAllowPrefixFromPageUrl(await page.url());
        if (ap && !allowed.some((x) => x === ap)) allowed = [ap, ...allowed];
      }
    }
    if (g && typeof g === "object" && g.autoAllowCurrentPagePrefix === true && allowed.length) {
      await nav.applyNavigationPolicy(page, undefined, allowed);
    }

    const { combined, guardLen } = vmScript.combineScriptWithOptionalGuard(
      scriptText,
      blocked,
      allowed,
      vmPrependNavigationGuard,
    );

    await vmScript.evalVmScriptInPage(page, combined);
    if (body.vmRememberLoadUrlForRestore !== false) {
      nav.rememberVmLoadUrlForPage(page, vmLoadBaseUrl);
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
    const delegate =
      body.xhrDelegateToClient === true ||
      body.delegateXhrToClient === true;
    const code = buildXhrPostCode(targetUrl, payload, contentType);
    if (delegate) {
      const capMsRaw = Number(body.xhrCaptureTimeoutMs);
      const capMs = Number.isFinite(capMsRaw) && capMsRaw > 0
        ? Math.min(capMsRaw, 120_000)
        : Math.min(timeout || 30_000, 120_000);
      const capPromise = xhrCapture.setPendingXhrCapture(page, targetUrl, capMs);
      const evPromise = page.evaluate(code);
      let captured;
      let evRes;
      try {
        [captured, evRes] = await Promise.all([capPromise, evPromise]);
      } catch (e) {
        xhrCapture.cancelPendingXhrCapture(page);
        throw e;
      }
      xhrResult = {
        delivery: "client",
        preparedRequest: {
          url: captured.url,
          postData: captured.postData,
          headers: captured.headers,
        },
        /** 페이지 컨텍스트 XHR 완료 결과(abort 시 status 0 등). 실제 응답 본문은 없음 */
        browser: evRes,
      };
    } else {
      xhrResult = await page.evaluate(code);
    }
  }

  if (vmResult && xhrResult) return { vm: vmResult, xhr: xhrResult };
  if (vmResult) return vmResult;
  return xhrResult;
}

module.exports = {
  executeOnPage,
  buildXhrPostCode,
  serializeBody,
};
