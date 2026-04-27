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
 * — E-server-Version: package.json version
 * — E-server-Host: os.hostname() (물리/컨테이너 구분용)
 * — E-server-Build: EVER_SAFE_BUILD_ID 또는 BUILD_ID (선택, CI·도커 태그 등)
 * @param {import("express").Response} res
 */
function appendEvaluateWarmIdentityHeaders(res) {
  res.setHeader("E-server-Version", APP_VERSION);
  res.setHeader("E-server-Host", HOSTNAME);
  const build = resolveBuildId();
  if (build) res.setHeader("E-server-Build", build);
  const exposed = build
    ? "E-server-Version, E-server-Host, E-server-Build"
    : "E-server-Version, E-server-Host";
  res.setHeader("Access-Control-Expose-Headers", exposed);
}

module.exports = { appendEvaluateWarmIdentityHeaders };
