const os = require("os");
const pkg = require("../package.json");

/** @param {unknown} val */
function headerSafe(val) {
  return String(val ?? "")
    .replace(/[\0\r\n]/g, "")
    .slice(0, 512);
}

const APP_VERSION = headerSafe(pkg.version || "0.0.0");
const HOSTNAME = headerSafe(os.hostname());

function resolveBuildId() {
  return headerSafe((process.env.EVER_SAFE_BUILD_ID || process.env.BUILD_ID || "").trim());
}

/**
 * POST /evaluate/warm 응답에 인스턴스 식별용 헤더를 붙인다.
 * — X-Ever-Safe-Version: package.json version
 * — X-Ever-Safe-Host: os.hostname() (물리/컨테이너 구분용)
 * — X-Ever-Safe-Build: EVER_SAFE_BUILD_ID 또는 BUILD_ID (선택, CI·도커 태그 등)
 * @param {import("express").Response} res
 */
function appendEvaluateWarmIdentityHeaders(res) {
  res.setHeader("X-Ever-Safe-Version", APP_VERSION);
  res.setHeader("X-Ever-Safe-Host", HOSTNAME);
  const build = resolveBuildId();
  if (build) res.setHeader("X-Ever-Safe-Build", build);
  const exposed = build
    ? "X-Ever-Safe-Version, X-Ever-Safe-Host, X-Ever-Safe-Build"
    : "X-Ever-Safe-Version, X-Ever-Safe-Host";
  res.setHeader("Access-Control-Expose-Headers", exposed);
}

module.exports = { appendEvaluateWarmIdentityHeaders };
