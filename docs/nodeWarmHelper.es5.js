/**
 * [공통] Node 웜(health → 필요 시 retry → evaluate/warm) — ES5
 *
 * 진입 함수: **nodeSession_run(config)** — 예전 3단계(session/create…) 코드와 **함수명 동일**하게 유지.
 * (내부 구현만 웜 + evaluate/warm 으로 바뀜. 구 방식 파일과 병합 시 이름 충돌 없이 교체 가능.)
 *
 * 전제: 서버에 WARM_START_URL 설정, 웜 구성 완료 후 사용.
 * BigCommon.getHttpData(cbId, method, host, path, body, header, encoding, "", "n")
 *   → 콜백 인자 ret 에서 HTTP 응답 본문이 ret.result (문자열) 로 온다고 가정.
 *
 * config 필드:
 *   callbackId   (필수)
 *   targetUrl    (필수)  은행 API 전체 URL (예: HOST_URL + "/inbank/itfc/….do")
 *   payload      (필수)  **객체** 또는 **JSON 문자열**. 전송 시 서버 규격에 맞게 **커스텀 Base64 문자열**로
 *                        인코딩됨(알파벳 = NODE_BROWSER_ADMIN_TOKEN / config.adminToken, **65자**).
 *   header       BigCommon용 (GET/POST 공통)
 *   adminToken   (선택) POST /warm/retry 시 X-Browser-Admin-Token. 생략 시 아래 NODE_BROWSER_ADMIN_TOKEN 사용
 *   onSuccess(postData)  — EverSafe 처리된 POST 본문 문자열 → BigCommon.getHttpData 로 그대로 전달
 *   onError(message)
 *
 * 옵션:
 *   healthPollMax      기본 30  — warmSetupInFlight 시 health 재폴링 최대 횟수
 *   healthPollIntervalMs 기본 1000
 *
 * [마이그레이션 예 — AcctPage 에서 조회 호출]
 *
 *   nodeSession_run({
 *     callbackId : "AcctInquiry",
 *     targetUrl  : HOST_URL + "/inbank/itfc/MSOEBB081402S1.do",
 *     payload    : param,
 *     header     : HEADER1,
 *     onSuccess  : function(postData) {
 *       BigCommon.getHttpData("GetAcctInquiry", "POST", HOST_URL, "/inbank/itfc/MSOEBB081402S1.do",
 *         postData, HEADER1, "UTF-8", "", "n");
 *     },
 *     onError    : function(msg) {
 *       ARRAY[0] = new RetObj(SERVICENAME, "S900001", msg, "", ORGCODE, []);
 *       BigCommon.setResult(ARRAY);
 *     }
 *   });
 *
 * 상단 NODE_SESSION_HOST 는 Node 서버 주소(예: http://192.168.0.125:3000), targetUrl 은 은행 HOST 와 별개.
 * 상단 NODE_BROWSER_ADMIN_TOKEN 은 서버 BROWSER_ADMIN_TOKEN 과 동일 값을 한 번만 넣으면 됨(warm/retry 헤더 + evaluate/warm payload 인코딩).
 */

var NODE_SESSION_HOST = "http://192.168.0.125:3000";

/**
 * 서버 .env 의 BROWSER_ADMIN_TOKEN 과 동일(65자 권장).
 * warm/retry 헤더 및 evaluate/warm 의 payload 인코딩 알파벳으로 사용.
 * 빈 문자열이면 warm/retry 시 토큰 헤더 안 붙음 — 이 경우 evaluate/warm 은 알파벳 부족으로 실패할 수 있음.
 */
var NODE_BROWSER_ADMIN_TOKEN = "";

var _global = (function() { return this; })();

/** ret.result 문자열을 JSON 객체로 */
function nodeWarm_parseResponseBody(ret) {
  var raw = ret;
  if (ret && typeof ret === "object" && ret.result !== undefined) {
    raw = ret.result;
  }
  var s = typeof raw === "string" ? raw : JSON.stringify(raw);
  return JSON.parse(s);
}

/**
 * session/evaluate step3 와 동일: xhrDelegateToClient 결과에서 postData 추출
 * 서버: { "result": { delivery, preparedRequest, ... }, "finalUrl"? }
 * 일부 래퍼는 result 안에 또 result 가 중첩될 수 있어 둘 다 시도
 */
function nodeWarm_extractPostData(ret) {
  var target = nodeWarm_parseResponseBody(ret);
  var layer = typeof target.result === "undefined" ? target : target.result;
  if (typeof layer === "string") {
    try { layer = JSON.parse(layer); } catch (e) { return null; }
  }
  var r = layer && layer.result !== undefined ? layer.result : layer;
  if (typeof r === "string") {
    try { r = JSON.parse(r); } catch (e2) { return null; }
  }
  if (r && r.preparedRequest && r.preparedRequest.postData) {
    return r.preparedRequest.postData;
  }
  return null;
}

/**
 * POST /warm/retry 용 — 문자열 헤더 끝에 X-Browser-Admin-Token 줄 추가.
 * BigCommon 이 헤더를 다른 형식(객체 등)으로 받으면 이 함수만 맞게 수정.
 */
function nodeWarm_mergeAdminHeader(baseHeader, adminToken) {
  if (!adminToken || String(adminToken).length === 0) return baseHeader;
  if (typeof baseHeader === "string") {
    var line = "X-Browser-Admin-Token: " + adminToken;
    if (baseHeader.length === 0) return line + "\r\n";
    var endsNl = /\r?\n$/.test(baseHeader);
    return baseHeader + (endsNl ? "" : "\r\n") + line + "\r\n";
  }
  return baseHeader;
}

/** config.adminToken 우선, 없으면 NODE_BROWSER_ADMIN_TOKEN */
function nodeWarm_effectiveAdminToken(config) {
  if (config && config.adminToken && String(config.adminToken).length > 0) {
    return String(config.adminToken);
  }
  if (NODE_BROWSER_ADMIN_TOKEN && String(NODE_BROWSER_ADMIN_TOKEN).length > 0) {
    return String(NODE_BROWSER_ADMIN_TOKEN);
  }
  return "";
}

/** 서버 lib/payloadCustomBase64.encodeCustomBase64 와 동일 (알파벳 65자) */
function nodeWarm_encodeCustomBase64(plain, alphabet) {
  if (plain == null || alphabet == null || alphabet === "") {
    throw new Error("인코딩 입력이 올바르지 않습니다.");
  }
  var cleanAlphabet = String(alphabet).replace(/[\s\t\n\r]/g, "");
  if (cleanAlphabet.length !== 65) {
    throw new Error("알파벳 길이가 올바르지 않습니다.");
  }
  var table = cleanAlphabet.substring(0, 64);
  var pad = cleanAlphabet.charAt(64);
  var uriStr = encodeURIComponent(String(plain));
  var bytes = [];
  for (var bi = 0; bi < uriStr.length; bi++) {
    var cc = uriStr.charCodeAt(bi);
    if (cc > 255) {
      throw new Error("인코딩할 수 없는 문자가 포함되어 있습니다.");
    }
    bytes.push(cc);
  }
  var out = "";
  for (var j = 0; j < bytes.length; j += 3) {
    var b1 = bytes[j];
    var b2 = j + 1 < bytes.length ? bytes[j + 1] : 0;
    var b3 = j + 2 < bytes.length ? bytes[j + 2] : 0;
    var nn = (b1 << 16) | (b2 << 8) | b3;
    var k1 = (nn >> 18) & 63;
    var k2 = (nn >> 12) & 63;
    var k3 = (nn >> 6) & 63;
    var k4 = nn & 63;
    out += table.charAt(k1) + table.charAt(k2);
    if (j + 1 < bytes.length) {
      out += table.charAt(k3);
    } else {
      out += pad;
    }
    if (j + 2 < bytes.length) {
      out += table.charAt(k4);
    } else {
      out += pad;
    }
  }
  return out;
}

function nodeSession_run(config) {
  var cbId = config.callbackId;
  var pollMax = config.healthPollMax || 30;
  var pollMs = config.healthPollIntervalMs || 1000;
  var pollCount = 0;

  function fail(msg) {
    if (config.onError) config.onError(msg);
  }

  function okPostData(postData) {
    if (config.onSuccess) config.onSuccess(postData);
  }

  function doEvaluateWarm() {
    var alphabet = nodeWarm_effectiveAdminToken(config);
    if (!alphabet || alphabet.length !== 65) {
      fail("evaluate/warm: 서버 BROWSER_ADMIN_TOKEN 과 동일한 65자가 필요합니다(NODE_BROWSER_ADMIN_TOKEN 또는 config.adminToken)");
      return;
    }
    var payloadPlain =
      typeof config.payload === "string" ? String(config.payload) : JSON.stringify(config.payload);
    var encodedPayload;
    try {
      encodedPayload = nodeWarm_encodeCustomBase64(payloadPlain, alphabet);
    } catch (encErr) {
      fail("evaluate/warm 인코딩 실패: " + (encErr && encErr.message ? encErr.message : encErr));
      return;
    }
    var stepParam = JSON.stringify({
      targetUrl: config.targetUrl,
      payload: encodedPayload,
      xhrDelegateToClient: true,
      xhrCaptureTimeoutMs: 60000,
      timeout: 60000
    });

    _global[cbId + "_ew"] = function(retEw) {
      try {
        var postData = nodeWarm_extractPostData(retEw);
        if (!postData) {
          fail("postData 없음 (evaluate/warm)");
          return;
        }
        okPostData(postData);
      } catch (e) {
        fail("evaluate/warm 오류: " + (e && e.message ? e.message : e));
      }
    };

    BigCommon.getHttpData(cbId + "_ew", "POST", NODE_SESSION_HOST, "/evaluate/warm", stepParam, config.header, "UTF-8", "", "n");
  }

  function doWarmRetry() {
    var retryHeader = nodeWarm_mergeAdminHeader(config.header, nodeWarm_effectiveAdminToken(config));
    _global[cbId + "_wr"] = function(retR) {
      try {
        var jr = nodeWarm_parseResponseBody(retR);
        if (jr.error) {
          fail("warm/retry 실패: " + jr.error);
          return;
        }
        if (jr.ok && jr.state && jr.state.warmReady === true) {
          doEvaluateWarm();
          return;
        }
        pollCount = 0;
        scheduleHealth(0);
      } catch (e) {
        fail("warm/retry 응답 파싱 오류: " + (e && e.message ? e.message : e));
      }
    };

    BigCommon.getHttpData(cbId + "_wr", "POST", NODE_SESSION_HOST, "/warm/retry", "{}", retryHeader, "UTF-8", "", "n");
  }

  function scheduleHealth(delayMs) {
    var d = typeof delayMs === "number" ? delayMs : pollMs;
    setTimeout(function() {
      readHealth();
    }, d);
  }

  function readHealth() {
    var ghTag = pollCount;
    _global[cbId + "_gh" + ghTag] = function(retH) {
      try {
        var h = nodeWarm_parseResponseBody(retH);

        if (h.warmConfigError) {
          fail("warm 설정 오류: " + (h.warmLastError || "warmConfigError"));
          return;
        }
        if (!h.warmEnabled) {
          fail("웜 비활성 — 서버에 WARM_START_URL 필요");
          return;
        }

        if (h.warmReady === true && h.warmSetupInFlight !== true) {
          doEvaluateWarm();
          return;
        }

        if (h.warmSetupInFlight === true) {
          pollCount++;
          if (pollCount >= pollMax) {
            fail("warm 구성 중 대기 시간 초과(warmSetupInFlight)");
            return;
          }
          scheduleHealth(pollMs);
          return;
        }

        if (h.warmEnabled === true && h.warmReady !== true && h.warmSetupInFlight !== true) {
          doWarmRetry();
          return;
        }

        fail("웜 상태를 처리할 수 없음 (warmReady=" + h.warmReady + ")");
      } catch (e) {
        fail("health 오류: " + (e && e.message ? e.message : e));
      }
    };

    BigCommon.getHttpData(cbId + "_gh" + ghTag, "GET", NODE_SESSION_HOST, "/health", "", config.header, "UTF-8", "", "n");
  }

  // 진입: health → (준비됨) evaluate/warm | (구성 중) 폴링 | (미준비·구성 아님) warm/retry
  pollCount = 0;
  readHealth();
}

/** 예전 문서/일부 코드 호환용 별칭 — nodeSession_run 과 동일 */
var nodeWarm_run = nodeSession_run;
