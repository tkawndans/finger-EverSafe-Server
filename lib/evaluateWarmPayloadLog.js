/**
 * evaluate/warm·health 페이로드·응답 로그.
 * 기본: 기록함. LOG_EVALUATE_WARM_PAYLOAD=0 (트림 후)일 때만 끔.
 *
 * 활성 파일: process.cwd()/log/serverlog.log (NDJSON append)
 * 한국 날짜(Asia/Seoul)가 바뀌면 serverlog.log → serverlog-YYYYMMDD.log 로 이름만 바꾼 뒤 새 serverlog.log 생성.
 *
 * 보관: LOG_RETENTION_DAYS (기본 10). 지난 일수보다 오래된 serverlog-*.log, 구형 logYYYYMMDD.log 등만 삭제.
 *       0 이면 자동 삭제 안 함. (활성 serverlog.log 는 삭제하지 않음)
 *
 * 필드 `t`: Asia/Seoul 기준 `YYYY-MM-DD HH:mm:ss.SSS`
 */

const fs = require("fs");
const path = require("path");

const MAX_JSON_BYTES = 24_000;
const SEOUL_TZ = "Asia/Seoul";
const ACTIVE_LOG = "serverlog.log";

/** 한국시간 가독 형식 (예: 2026-04-27 11:22:47.078) */
function formatKstTimestamp(date = new Date()) {
  const base = {
    timeZone: SEOUL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  };
  try {
    return date
      .toLocaleString("sv-SE", {
        ...base,
        fractionalSecondDigits: 3,
      })
      .replace(",", ".");
  } catch {
    return date.toLocaleString("sv-SE", base);
  }
}

/** 로그 파일명용 YYYY-MM-DD (한국 자정 기준 일자) */
function formatKstDateForFilename(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SEOUL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** YYYYMMDD (한국 자정 기준) */
function formatKstDateYyyymmdd(date = new Date()) {
  return formatKstDateForFilename(date).replace(/-/g, "");
}

/** 보관 주기(일). 미설정·빈 값 → 10. 0 → 자동 삭제 안 함. */
function getRetentionDays() {
  const v = process.env.LOG_RETENTION_DAYS;
  if (v === undefined || v === null || String(v).trim() === "") return 10;
  const n = parseInt(String(v).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return 10;
  return Math.min(n, 3650);
}

/** 미설정·빈 값·"0" 이 아니면 기록. 명시적으로 `0` 만 끔. */
function isEnabled() {
  const v = process.env.LOG_EVALUATE_WARM_PAYLOAD;
  if (v === undefined || v === null) return true;
  return String(v).trim() !== "0";
}

function logDir() {
  return path.join(process.cwd(), "log");
}

let dirEnsured = false;

function ensureDir() {
  if (dirEnsured) return;
  fs.mkdirSync(logDir(), { recursive: true });
  dirEnsured = true;
}

/** 현재 쓰는 단일 로그 파일 */
function activeLogFilePath() {
  return path.join(logDir(), ACTIVE_LOG);
}

/** 한국 날짜가 바뀌면 전날 serverlog.log 를 serverlog-YYYYMMDD.log 로 롤링 */
let lastKstYyyymmdd = null;

function maybeRotateServerlog() {
  const today = formatKstDateYyyymmdd(new Date());
  if (lastKstYyyymmdd === null) {
    lastKstYyyymmdd = today;
    return;
  }
  if (lastKstYyyymmdd === today) return;

  const main = activeLogFilePath();
  try {
    if (fs.existsSync(main)) {
      const st = fs.statSync(main);
      if (st.size > 0) {
        const dest = path.join(logDir(), `serverlog-${lastKstYyyymmdd}.log`);
        if (!fs.existsSync(dest)) {
          fs.renameSync(main, dest);
        } else {
          fs.renameSync(main, path.join(logDir(), `serverlog-${lastKstYyyymmdd}-${Date.now()}.log`));
        }
      }
    }
  } catch (e) {
    console.error("[evaluateWarmPayloadLog] rotate failed:", e && e.message ? e.message : e);
  }
  lastKstYyyymmdd = today;
}

let lastPruneAt = 0;

function pruneOldArchiveLogs() {
  const days = getRetentionDays();
  if (days <= 0) return;

  const now = Date.now();
  if (now - lastPruneAt < 60_000) return;
  lastPruneAt = now;

  const maxAgeMs = days * 86400000;
  let names;
  try {
    names = fs.readdirSync(logDir());
  } catch {
    return;
  }

  for (const name of names) {
    if (name === ACTIVE_LOG) continue;
    const full = path.join(logDir(), name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const isArchive = /^serverlog-\d{8}(\-\d+)?\.log$/.test(name);
    const isLegacyLog = /^log\d{8}\.log$/.test(name);
    const isLegacyEval = /^evaluate-warm-payload-\d{4}-\d{2}-\d{2}\.log$/.test(name);
    if (!isArchive && !isLegacyLog && !isLegacyEval) continue;

    if (now - stat.mtimeMs > maxAgeMs) {
      try {
        fs.unlinkSync(full);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

/**
 * 객체를 JSON으로 만든 뒤 UTF-8 바이트 기준으로 잘라 문자열로 반환(로그 한 줄용).
 */
function truncateJsonString(obj, maxBytes = MAX_JSON_BYTES) {
  const s = JSON.stringify(obj);
  const overhead = Buffer.byteLength("…(truncated)", "utf8");
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let n = s.length;
  while (n > 0) {
    const sub = s.slice(0, n);
    if (Buffer.byteLength(sub, "utf8") + overhead <= maxBytes) {
      return sub + "…(truncated)";
    }
    n = Math.floor(n * 0.85);
  }
  return "…(truncated)";
}

/**
 * @param {Record<string, unknown>} entry phase 등 메타 + payload
 */
function append(entry) {
  if (!isEnabled()) return;
  try {
    ensureDir();
    maybeRotateServerlog();
    pruneOldArchiveLogs();
    const line =
      JSON.stringify({
        t: formatKstTimestamp(new Date()),
        ...entry,
      }) + "\n";
    fs.appendFileSync(activeLogFilePath(), line, "utf8");
  } catch (e) {
    console.error("[evaluateWarmPayloadLog] append failed:", e && e.message ? e.message : e);
  }
}

module.exports = {
  isEnabled,
  append,
  logDir,
  truncateJsonString,
  formatKstTimestamp,
  formatKstDateForFilename,
  formatKstDateYyyymmdd,
  getRetentionDays,
  activeLogFilePath,
};
