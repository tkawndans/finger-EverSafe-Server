const warmSession = require("./warmSession");
const { ALPHABET_LEN } = require("./payloadCustomBase64");

/**
 * GET /health 와 동일한 본문 객체. POST /evaluate/warm 응답에도 붙여 같은 인스턴스 상태를 전달할 때 사용.
 *
 * @param {{
 *   getBrowser: () => import("puppeteer").Browser | null | undefined,
 *   getSessions: () => Map<unknown, unknown> | { size: number },
 *   getHeadful: () => boolean,
 * }} deps
 */
function buildHealthSnapshot(deps) {
  const { getBrowser, getSessions, getHeadful } = deps;
  const warm = warmSession.getState();
  const tokenTrim = (process.env.BROWSER_ADMIN_TOKEN || "").trim();
  const sessions = getSessions();
  const n = sessions && typeof sessions.size === "number" ? sessions.size : 0;
  return {
    status: "ok",
    browser: !!getBrowser(),
    sessions: n,
    headful: getHeadful(),
    warmEnabled: warm.warmEnabled,
    warmReady: warm.warmReady,
    warmLastError: warm.warmLastError,
    warmSetupInFlight: warm.warmSetupInFlight,
    warmUrl: warm.warmUrl,
    /** POST /evaluate/warm payload 디코드에 필요(BROWSER_ADMIN_TOKEN 정확히 ALPHABET_LEN 자) */
    warmPayloadEncodingReady: tokenTrim.length === ALPHABET_LEN,
    ...(warm.warmConfigError ? { warmConfigError: true } : {}),
  };
}

module.exports = { buildHealthSnapshot };
