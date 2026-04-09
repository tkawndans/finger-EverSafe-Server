/**
 * Puppeteer request 이벤트에서 XHR POST 본문을 캡처한 뒤 abort.
 * EverSafe 등이 send()에서 본문을 변조한 뒤에도, 실제로 네트워크로 나가기 직전 값이 postData로 올라온다.
 */

const pendingByPage = new WeakMap();

function normalizeForMatch(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search}`;
  } catch (_) {
    return String(url).trim();
  }
}

function urlsMatch(a, b) {
  return normalizeForMatch(a) === normalizeForMatch(b);
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string} targetUrl evaluate에서 xhr.open에 넣는 URL과 동일하게
 * @param {number} timeoutMs
 * @returns {Promise<{ url: string, postData: string, headers: Record<string,string> }>}
 */
function setPendingXhrCapture(page, targetUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingByPage.delete(page);
      reject(new Error(`XHR 캡처 타임아웃 (${timeoutMs}ms): ${targetUrl}`));
    }, timeoutMs);
    pendingByPage.set(page, {
      targetUrl: String(targetUrl).trim(),
      resolve: (data) => {
        clearTimeout(timeoutId);
        pendingByPage.delete(page);
        resolve(data);
      },
      reject: (e) => {
        clearTimeout(timeoutId);
        pendingByPage.delete(page);
        reject(e);
      },
      timeoutId,
    });
  });
}

/**
 * server.js 의 page.on("request") 맨 앞에서 호출. 처리했으면 true (이미 abort/resolve 함).
 */
function handleRequestInCapture(page, req) {
  const p = pendingByPage.get(page);
  if (!p) return false;
  try {
    if (req.method() !== "POST") return false;
    if (!urlsMatch(req.url(), p.targetUrl)) return false;
    const postData = req.postData() || "";
    const headers = { ...req.headers() };
    req.abort();
    p.resolve({
      url: req.url(),
      postData,
      headers,
    });
    return true;
  } catch (e) {
    p.reject(e);
    return true;
  }
}

function cancelPendingXhrCapture(page) {
  const p = pendingByPage.get(page);
  if (!p) return;
  try {
    clearTimeout(p.timeoutId);
  } catch (_) {
    /* ignore */
  }
  pendingByPage.delete(page);
}

module.exports = {
  setPendingXhrCapture,
  handleRequestInCapture,
  cancelPendingXhrCapture,
  urlsMatch,
};
