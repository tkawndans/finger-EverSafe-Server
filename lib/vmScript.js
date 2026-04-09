const fsp = require("fs/promises");
const path = require("path");

/** NodeServer 프로젝트 루트 (lib/ 기준 상위) — CWD와 무관 */
const PROJECT_ROOT = path.join(__dirname, "..");

/** 기본 VM 스크립트 — 프로젝트 내 고정 위치 */
const DEFAULT_EVERSAFE_RELATIVE = path.join("ever-safe", "EverSafe.txt");

/**
 * EVERSAFE_TXT_PATH
 * - 비어 있음: `ever-safe/EverSafe.txt`
 * - 절대 경로: 그대로 사용
 * - 상대 경로: 프로젝트 루트 기준 (예: `ever-safe/EverSafe_홈택스.txt`)
 */
function getEverSafeScriptPath() {
  const raw = (process.env.EVERSAFE_TXT_PATH || "").trim();
  if (raw) {
    if (path.isAbsolute(raw)) {
      return path.normalize(raw);
    }
    const rel = raw.replace(/^[/\\]+/, "");
    return path.join(PROJECT_ROOT, rel);
  }
  return path.join(PROJECT_ROOT, DEFAULT_EVERSAFE_RELATIVE);
}

/** `/session/evaluate` 의 vm 주입용 — 로컬 EverSafe.txt */
async function readEverSafeVmScript() {
  const resolvedPath = getEverSafeScriptPath();
  let scriptText;
  try {
    scriptText = await fsp.readFile(resolvedPath, "utf8");
  } catch (e) {
    throw new Error(`EverSafe VM 스크립트를 읽을 수 없습니다 (${resolvedPath}): ${e.message}`);
  }
  if (!String(scriptText).trim()) {
    throw new Error(`EverSafe VM 스크립트가 비어 있습니다: ${resolvedPath}`);
  }
  return { scriptText, resolvedPath };
}

/** 테스트·기타: URL에서 스크립트 다운로드 (쿠키 포함) */
async function fetchVmScript(baseUrl, page) {
  const sep = baseUrl.includes("?") ? "&" : "?";
  const fullUrl = `${baseUrl}${sep}t=${Date.now()}`;

  const cookies = await page.cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  let res;
  try {
    res = await fetch(fullUrl, {
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
    });
  } catch (e) {
    const detail = formatFetchError(e);
    const tlsHint =
      /certificate|SSL|TLS|UNABLE_TO_VERIFY|self-signed|cert/i.test(detail) &&
      process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0"
        ? " [Fiddler 등 HTTPS 가로채기 시: 같은 세션에서 $env:NODE_TLS_REJECT_UNAUTHORIZED='0' (개발 전용) 후 서버 재시작]"
        : "";
    throw new Error(`VM script fetch failed: ${detail}${tlsHint}`);
  }
  if (!res.ok) throw new Error(`VM script fetch failed: HTTP ${res.status}`);
  const scriptText = await res.text();
  return { scriptText, fullUrl };
}

function formatFetchError(err) {
  const parts = [err && err.message ? err.message : String(err)];
  let c = err && err.cause;
  for (let i = 0; c && i < 6; i++) {
    const m = c.message || String(c);
    if (m && !parts.includes(m)) parts.push(m);
    c = c.cause;
  }
  return parts.join(" | ");
}

/**
 * 난독화 스크립트보다 먼저 실행 — history / Location / click·submit·open 보조
 */
function buildVmNavigationGuardPrefixString(blocked, allowed) {
  const B = JSON.stringify(blocked || []);
  const A = JSON.stringify(allowed || []);
  return `;(function(){
          var __B=${B},__A=${A};
          function __navVmBad(u){
            if(u==null||u==="")return false;
            var abs;
            try{abs=new URL(String(u),location.href).href}catch(_){return false}
            for(var i=0;i<__B.length;i++){if(abs.startsWith(__B[i]))return true}
            if(__A.length>0&&!__A.some(function(x){return abs.startsWith(x)}))return true;
            return false;
          }
          try{
            var __hp=history.pushState.bind(history),__hr=history.replaceState.bind(history);
            history.pushState=function(s,t,u){if(__navVmBad(u))return;return __hp.apply(history,arguments)};
            history.replaceState=function(s,t,u){if(__navVmBad(u))return;return __hr.apply(history,arguments)};
          }catch(_){}
          try{
            var __la=Location.prototype.assign,__lr=Location.prototype.replace;
            Location.prototype.assign=function(u){if(__navVmBad(u))return;return __la.call(this,u)};
            Location.prototype.replace=function(u){if(__navVmBad(u))return;return __lr.call(this,u)};
          }catch(_){}
          try{
            var __d=Object.getOwnPropertyDescriptor(Location.prototype,"href");
            if(__d&&__d.set){
              var __os=__d.set;
              __d.set=function(v){if(__navVmBad(v))return;return __os.call(this,v)};
              Object.defineProperty(Location.prototype,"href",__d);
            }
          }catch(_){}
          try{
            document.addEventListener("click",function(e){
              var a=e.target&&e.target.closest&&e.target.closest("a[href]");
              if(a&&__navVmBad(a.href)){e.preventDefault();e.stopPropagation();}
            },true);
            document.addEventListener("submit",function(e){
              var t=e.target;
              if(t&&t.action&&__navVmBad(String(t.action))){e.preventDefault();}
            },true);
            var __wo=window.open;
            window.open=function(){
              if(arguments.length&&__navVmBad(String(arguments[0])))return null;
              return __wo.apply(window,arguments);
            };
          }catch(_){}
          })();`;
}

/** 페이지 컨텍스트에서 VM 문자열 eval (단일 진입점) */
async function evalVmScriptInPage(page, combinedSource) {
  await page.evaluate((src) => {
    eval(src);
  }, combinedSource);
}

function combineScriptWithOptionalGuard(scriptText, blocked, allowed, useGuard) {
  if (!useGuard || (!blocked.length && !allowed.length)) return { combined: scriptText, guardLen: 0 };
  const guard = buildVmNavigationGuardPrefixString(blocked, allowed);
  return { combined: `${guard}\n${scriptText}`, guardLen: guard.length };
}

module.exports = {
  getEverSafeScriptPath,
  readEverSafeVmScript,
  fetchVmScript,
  buildVmNavigationGuardPrefixString,
  evalVmScriptInPage,
  combineScriptWithOptionalGuard,
};
