# NodeServer — Express + Puppeteer

실제 Chromium 브라우저 환경에서 JavaScript를 실행하는 Node.js 서버.  
Go 등 외부 서버에서 REST API로 호출하여 **보안 모듈 로드 → XHR POST → 결과 수집** 플로우를 자동화합니다.

---

## 목차

1. [빠른 시작](#빠른-시작)
2. [운영·개발 실행 및 종료](#ops-dev-run)
3. [패킷 캡처 (Fiddler 등) — Node 아웃바운드](#fiddler-node-proxy)
4. [환경 변수](#환경-변수)
5. [API 요약](#api-요약)
6. [세션 API — 상세](#세션-api--상세)
7. [Stateless API — 상세](#stateless-api--상세)
8. [Evaluate 실행 모드](#evaluate-실행-모드)
9. [Health Check](#health-check)
10. [테스트 페이지](#테스트-페이지)
11. [연동 예시 (Go)](#연동-예시-go)
12. [시퀀스 다이어그램](#시퀀스-다이어그램)
13. [Docker (Linux)](#docker-linux)

---

## 빠른 시작

```bash
# 의존성 설치
npm install

# 개발 모드 (파일 변경 시 자동 재시작)
npm run dev

# 운영 모드
npm start
```

서버 시작 후:

- **REST API** → `http://localhost:3000`
- **테스트 페이지** → `http://localhost:3000/test`

---

<h2 id="ops-dev-run">운영·개발 실행 및 종료</h2>

### 운영 환경 (Node 직접 실행)

사전에 `npm install` 한 뒤, 프로젝트 루트에서:

```bash
# 운영 모드 (단일 프로세스)
npm start
# 또는
node server.js
```

운영에서는 테스트 UI를 끄는 것을 권장합니다.

**PowerShell (Windows)**

```powershell
$env:ENABLE_TEST_PAGE = "0"
npm start
```

**종료**

- 서버를 띄운 **같은 터미널**에서 **`Ctrl+C`** → `SIGINT`를 받아 세션·브라우저를 정리한 뒤 종료합니다.
- **systemd / PM2** 등으로 백그라운드에 올린 경우: 해당 도구의 stop/restart 명령을 사용합니다 (예: `pm2 stop all`, `systemctl stop nodeserver` — 서비스 이름은 환경에 맞게 지정).

### 개발·테스트 환경

```bash
npm run dev
```

`node --watch`로 `server.js` 변경 시 자동 재시작됩니다.

**종료**: 운영과 동일하게 해당 터미널에서 **`Ctrl+C`**.

테스트 페이지는 기본으로 켜져 있으며, 브라우저에서 `http://localhost:3000/test` 로 확인합니다.

### Docker로 운영할 때 (요약)

백그라운드 기동·중지는 [Docker (Linux)](#docker-linux) 절을 따릅니다.

```bash
docker compose up -d    # 실행
docker compose down     # 종료(컨테이너 제거)
```

---

<h2 id="fiddler-node-proxy">패킷 캡처 (Fiddler 등) — Node 아웃바운드</h2>

`vmLoadBaseUrl` 로 보안 스크립트를 받을 때처럼 **Node 프로세스가 직접 `fetch` 하는 요청**은, 환경 변수만으로는 내장 `fetch`가 프록시를 타지 않는 경우가 있어, 본 프로젝트는 **`HTTP_PROXY` / `HTTPS_PROXY` 가 설정되면 `undici`의 `EnvHttpProxyAgent`로 글로벌 디스패처를 설정**합니다. Fiddler 등 **로컬 프록시**로 이 트래픽을 보려면 **서버를 기동하기 전에** 아래를 **같은 PowerShell 세션**에서 설정합니다.

**Fiddler Classic 기본 프록시: `127.0.0.1:8888`** (Everywhere 등은 포트가 다를 수 있음)

```powershell
# Fiddler 실행 후, Node 서버를 띄우기 직전에 — 같은 PowerShell 세션에서:
$env:HTTP_PROXY  = "http://127.0.0.1:8888"
$env:HTTPS_PROXY = "http://127.0.0.1:8888"

# Fiddler에서 HTTPS 복호화(Decrypt HTTPS)를 켠 경우에만 — 개발 전용 (Node fetch / vmLoadBaseUrl TLS 오류 방지)
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"

# XHR(Chromium) 트래픽도 Fiddler에 보이게 — HTTP_PROXY와 별도
$env:PUPPETEER_PROXY = "http://127.0.0.1:8888"

node server.js
# 또는 npm start / npm run dev
```

시작 로그에 `[proxy] fetch() → HTTP(S)_PROXY 사용` 이 나오면 Node 측 `fetch`가 프록시를 경유하는 설정이 적용된 것입니다.

Fiddler에서 **HTTPS 복호화(Decrypt HTTPS)** 를 켰다면 **`NODE_TLS_REJECT_UNAUTHORIZED=0` 은 사실상 필수**입니다. 이 줄 없이 `HTTP_PROXY` 만 쓰면 `POST /session/evaluate` 의 `vmLoadBaseUrl` 단계에서 Node `fetch`가 **인증서 오류**로 실패하고, 응답은 `500` / `fetch failed` 형태가 될 수 있습니다.

**참고**

- **localhost:3000** REST API 자체를 Fiddler에만 보이게 할 필요는 없고, Node가 **외부 HTTPS로 나가는 연결**을 잡는 것이 목적일 때 위 설정을 씁니다.
- 로컬 API까지 프록시를 타면 이상해질 수 있어, 필요 시 예: `$env:NO_PROXY = "localhost,127.0.0.1"` 을 추가합니다.
- **Puppeteer(Chromium)** 가 은행으로 보내는 XHR은 **Node가 아니라 `chrome` 프로세스**에서 나갑니다. 그래서 **클라이언트 → `localhost:3000` POST**만 필터링하면 **XHR(은행 URL)은 안 보입니다.**  
  Chromium까지 Fiddler로 보내려면 서버 기동 전에 예: `$env:PUPPETEER_PROXY = "http://127.0.0.1:8888"` 를 설정합니다( `HTTP_PROXY` 와 **별도** — Node `fetch`용과 Chromium `--proxy-server`용). 시작 로그에 `[browser] Chromium proxy: ...` 가 나옵니다.  
  HTTPS 복호화 시 Chromium도 Fiddler 루트 인증서를 신뢰해야 하며, 필요 시 Fiddler의 **HTTPS 인증서를 시스템/Chrome에 설치**하는 절차를 따릅니다.
- **Node 24+** 에서는 `NODE_USE_ENV_PROXY=1` 만으로도 `fetch`가 환경 프록시를 쓰는 경우가 있으나, 이 저장소는 **`HTTP(S)_PROXY` 설정 시 undici로 통일**해 두었습니다.

---

## Docker (Linux)

Windows에서 개발한 뒤 **Linux 컨테이너**에서 돌릴 때는 아래만 있으면 됩니다(루트 `node_modules`는 **이미지 안에서** `npm ci`로 다시 설치).

### 이미지에 넣는 파일(레포 기준)

| 포함 | 설명 |
|------|------|
| `package.json`, `package-lock.json` | 의존성 잠금 |
| `server.js` | 메인 |
| `test.js`, `test/testPage.html` | `ENABLE_TEST_PAGE=1` 일 때만 필요하지만 Dockerfile에서 함께 복사 |
| `Dockerfile`, `.dockerignore`, `docker-compose.yml` | 빌드·실행용 |

**넣지 않음(일반적):** `node_modules`, `.cache/puppeteer`, `memory-bank`, `.git` — `.dockerignore`에 명시.

### Linux에서 Chromium

컨테이너에는 **apt로 설치한 Chromium**을 쓰고, `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` 으로 지정합니다. 로컬 Windows의 Chrome 캐시 경로는 사용하지 않습니다.

### 빌드·실행 예

```bash
docker compose build
docker compose up -d
# 또는
docker build -t puppeteer-api .
docker run -p 3000:3000 puppeteer-api
```

헬스 확인: `GET http://localhost:3000/health`

### 환경 변수 (컨테이너)

- `PORT` — 기본 `3000`
- `PUPPETEER_EXECUTABLE_PATH` — Dockerfile에서 `/usr/bin/chromium` 로 고정 가능
- `ENABLE_TEST_PAGE` — 운영에서는 `0` 권장(기본값 Dockerfile에 반영)

---

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3000` | 리스닝 포트 |
| `PUPPETEER_HEADFUL` | 미설정(권장) | **기본은 헤드리스.** **`1`일 때만** 시작 시 **헤드풀**. PowerShell에서 예전에 `$env:PUPPETEER_HEADFUL="1"` 을 넣었다면 **같은 터미널 세션**에 남아 있어 헤드풀로 뜰 수 있음 → `Remove-Item Env:PUPPETEER_HEADFUL` 또는 새 터미널. 서버 시작 로그에 `PUPPETEER_HEADFUL env=...` 가 출력됨. |
| `BROWSER_ADMIN_TOKEN` | 미설정 | 설정 시 `POST /browser/headful` 요청에 헤더 `X-Browser-Admin-Token: <값>` 필요. 미설정이면 로컬에서 토큰 없이 전환 가능. |
| `ENABLE_TEST_PAGE` | (활성) | `0` 으로 설정하면 `GET /test` 비활성화 |
| `PUPPETEER_EXECUTABLE_PATH` | 미설정 | Chromium 실행 파일 **절대 경로**. Docker/Linux에서는 `/usr/bin/chromium` 등. 설정 시 로컬 `.cache/puppeteer` 탐색보다 **우선** |
| `PUPPETEER_PROXY` | 미설정 | Fiddler 등에 **Chromium XHR**까지 보이게 할 때. 예: `http://127.0.0.1:8888` → `--proxy-server` 로 적용. **`HTTP_PROXY`와 별도** (Node `fetch`용과 무관). |
| `PUPPETEER_PROXY_BYPASS` | 미설정 | 설정 시 Chromium `--proxy-bypass-list`에 전달. 특정 호스트만 프록시 제외할 때. |

---

## API 요약

| 엔드포인트 | 메서드 | 설명 |
|-----------|--------|------|
| `/session/create` | POST | 세션(페이지) 생성, `sessionId` 반환 |
| `/session/evaluate` | POST | 세션 내 코드 실행 (VM / XHR / VM→XHR) |
| `/session/cookies` | POST | 세션 쿠키 조회 |
| `/session/destroy` | POST | 세션 파기 |
| `/session/list` | GET | 활성 세션 목록 |
| `/evaluate` | POST | Stateless 단발 실행 (세션 없이) |
| `/health` | GET | 서버 상태 확인 (`headful` 포함) |
| `/browser/headful` | GET | 현재 헤드풀 여부 `{ "headful": true|false }` |
| `/browser/headful` | POST | 런타임 헤드풀/헤드리스 전환. 이미 같은 모드면 재시작 생략(`relaunched: false`). Body: `{ "headful": true }` |

---

## 세션 API — 상세

### 1. 세션 생성

| 항목 | 내용 |
|------|------|
| **URL** | `{Base URL}/session/create` |
| **Method** | `POST` |
| **Headers** | `Content-Type: application/json` |

**Request Body**

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `url` | string | 아니오 | 초기 접속 URL (`page.goto`) |
| `waitUntilUrlContains` | string | 아니오 | `goto` 직후, **현재 페이지 URL에 이 부분 문자열이 포함될 때까지** 대기 (예: NetFunnel 후 `intro.do`로 이동할 때 `"intro.do"`). `timeout`과 동일 ms 한도 내에서 `page.url()` 폴링. |
| `cookies` | string \| array | 아니오 | 주입할 쿠키 |
| `headers` | object | 아니오 | 추가 HTTP 헤더 |
| `timeout` | number | 아니오 | 네비게이션 타임아웃(ms, 기본 30000) |
| `extractTnkSr` | boolean | 아니오 | `true`이면 `goto` 직후 HTML/전역에서 `var TNK_SR = '...'` 형태 값을 읽어 응답에 `TNK_SR`로 포함(없으면 필드 생략). 스크립트가 늦게 실행되면 `extractTnkSrWaitMs` 사용. |
| `extractTnkSrWaitMs` | number | 아니오 | `extractTnkSr` 전용. 추출 **전** 추가 대기(ms), 최대 60000. |

**Response (200)**

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "finalUrl": "https://cont.insure.or.kr/cont_web/intro.do",
  "TNK_SR": "c25793922cf3f349093c195e1ff70683"
}
```

`url`을 준 경우에만 `finalUrl`이 포함됩니다(대기 후 최종 주소). `extractTnkSr`로 찾은 경우에만 `TNK_SR`가 포함됩니다.

은행 등 응답의 **`Set-Cookie`는 Chromium이 해당 도메인에 자동 저장**하므로, 같은 세션에서 이어지는 XHR 등에 쿠키가 실립니다.

**예시 — NetFunnel 게이트 후 `intro.do`까지 기다린 뒤 세션 생성 완료**

```json
{
  "url": "https://cont.insure.or.kr/cont_web/",
  "waitUntilUrlContains": "intro.do",
  "timeout": 120000
}
```

---

### 2. 세션 내 실행 (evaluate)

| 항목 | 내용 |
|------|------|
| **URL** | `{Base URL}/session/evaluate` |
| **Method** | `POST` |
| **Headers** | `Content-Type: application/json` |

**Request Body — 임의 `code` 문자열은 받지 않음**

| 모드 | 사용할 필드 | 설명 |
|------|-------------|------|
| **보안 스크립트 로드** | `vmLoadBaseUrl` | 서버가 `fetch(URL + &t=timestamp)` → `eval` 템플릿을 조립. 패킷에는 **URL 한 줄**만 노출. |
| **POST (XHR)** | `targetUrl` + `payload` + (선택) `contentType` | 서버가 XHR 템플릿을 조립. **`contentType` 생략 시 기본값은 `application/json`**. 대상 사이트에 맞게 JSON·문자열·XML 등 본문 형식을 `payload`+`contentType`으로 맞춤. |
| **VM → XHR (순차)** | `vmLoadBaseUrl` + `targetUrl` + `payload` + (선택) `contentType` | **같은 페이지 컨텍스트**에서 먼저 보안 스크립트를 로드한 뒤, 이어서 XHR `POST`를 실행. 결과는 `{ "vm": { … }, "xhr": { "status", "data" } }` 형태. |

**필드 상세**

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `sessionId` | string | 예 | ①에서 받은 ID |
| `vmLoadBaseUrl` | string | VM 단독 또는 VM+XHR | 스크립트를 가져올 **베이스 URL** (`?`가 있으면 `&t=`, 없으면 `?t=` 로 타임스탬프 추가) |
| `targetUrl` | string | XHR 단독 또는 VM+XHR | `POST`할 **전체 URL** (`https://...`) |
| `payload` | object 또는 string | XHR 단독 또는 VM+XHR | **문자열**이면 그대로 본문(XML·폼·원문 등). **객체·배열 등**은 `contentType`이 JSON 계열일 때만 `JSON.stringify`로 직렬화. JSON이 아닌 `contentType`으로 객체를 보낼 수 없음(문자열로 보낼 것). |
| `contentType` | string | 아니오 | 요청 `Content-Type` 헤더. **생략 시 `application/json`** (유일한 기본값). 예: `application/x-www-form-urlencoded`, `application/xml`, `text/xml`, `text/plain` |
| `url` | string | 아니오 | 실행 **전에** 브라우저가 이동할 URL (`page.goto`) |
| `waitUntilUrlContains` | string | 아니오 | `url`을 줄 때, goto 후 URL에 이 문자열이 포함될 때까지 대기 (`/session/create`와 동일) |
| `timeout` | number | 아니오 | 네비게이션/평가 타임아웃(ms) |

**Response (200)**

```json
{
  "result": { },
  "finalUrl": "https://cont.insure.or.kr/cont_web/intro.do"
}
```

`url`을 준 경우에만 `finalUrl`이 포함될 수 있습니다.

---

#### 예시 — 보안 스크립트 로드 (`vmLoadBaseUrl`만)

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "vmLoadBaseUrl": "https://bank.jejubank.co.kr:6443/inbank/footer.do?evfw=v",
  "timeout": 60000
}
```

#### 예시 — VM 로드 후 폼 POST (`vmLoadBaseUrl` + `targetUrl` + `payload`)

보안 모듈을 먼저 로드한 뒤, 지정 URL로 POST 본문을 보냅니다.

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "vmLoadBaseUrl": "https://cont.insure.or.kr/cont_web/insurance/insuranceStep01.do",
  "targetUrl": "https://cont.insure.or.kr/cont_web/insurance/insuranceResult.do",
  "contentType": "application/x-www-form-urlencoded",
  "payload": "checkAgree1=Y&checkAgree2=Y&checkAgree3=Y&checkAgree4=Y&checkAgree5=Y&checkAgree6=Y",
  "timeout": 60000
}
```

#### 예시 — JSON API 호출 (`targetUrl` + `payload`; `contentType` 생략 시 `application/json`)

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "targetUrl": "https://bank.jejubank.co.kr:6443/inbank/itfc/MSOEBB081406S2.do",
  "payload": {
    "DATA": { "iqryDiv": "K" },
    "pagingInfo": { "pageNo": 1, "pageSize": 100 },
    "ipinsideData": { "ipinsideData": "", "ipinsideNAT": "", "ipinsideCOMM": "" }
  },
  "timeout": 60000
}
```

같은 요청에 명시적으로 `"contentType": "application/json"`을 넣어도 동작은 동일합니다. **`payload`가 문자열**이면 항상 그대로 본문으로 보냅니다(이때는 `contentType`을 대상 API에 맞게 지정).

#### 예시 — XML 본문 (`payload`는 문자열, `contentType`은 XML)

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "targetUrl": "https://example.com/api/soap-or-xml",
  "contentType": "application/xml",
  "payload": "<?xml version=\"1.0\"?><root><item>1</item></root>",
  "timeout": 60000
}
```

#### 예시 — `application/x-www-form-urlencoded` (키=값&… 형태 본문)

`checkSe=1&applcntNm=...` 같은 문자열은 JSON 객체로 표현할 수 없으므로, **`payload`에 문자열**로 넣고 **`contentType`** 을 지정합니다.

```json
{
  "sessionId": "…",
  "targetUrl": "https://cont.insure.or.kr/cont_web/insurance/insuranceResult.do",
  "contentType": "application/x-www-form-urlencoded",
  "payload": "checkSe=1&applcntNm=H5012lR54T337803iqGht2aOpDfg19P0nlYjAAS2DVEK7a5T3MPxJ/9x338==&telno=EgyLqTu4462q742/JS8HBiWs/vxQti/P3tNgwAuG3+NZkoOT8tLbNH9YHt7==&tCount=0&mCount=0&resultView=",
  "timeout": 60000
}
```

특수문자(`+`, `=`, `/` 등)가 값에 포함되면 **서버가 기대하는 인코딩**과 맞는지(이미 URL 인코딩된 문자열인지 등) 현장에서 한 번 확인하는 것이 좋습니다.

---

### 3. 세션 쿠키 조회

| 항목 | 내용 |
|------|------|
| **URL** | `{Base URL}/session/cookies` |
| **Method** | `POST` |
| **Headers** | `Content-Type: application/json` |

**Request Body**

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

**Response (200)**

```json
{
  "cookies": [
    { "name": "JSESSIONID", "value": "ABC123…", "domain": ".example.com", "path": "/", "httpOnly": true, "secure": true }
  ]
}
```

---

### 4. 세션 파기

| 항목 | 내용 |
|------|------|
| **URL** | `{Base URL}/session/destroy` |
| **Method** | `POST` |

**Request Body**

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

**Response (200)**

```json
{
  "success": true
}
```

---

### 5. 세션 목록 조회

| 항목 | 내용 |
|------|------|
| **URL** | `{Base URL}/session/list` |
| **Method** | `GET` |

**Response (200)**

```json
{
  "sessions": [
    { "sessionId": "a1b2c3d4-...", "createdAt": 1712100000000, "ageMs": 30000 }
  ],
  "count": 1
}
```

---

## Stateless API — 상세

### POST `/evaluate` — 단발성 실행

매 요청마다 새 페이지를 열고 닫습니다. 세션 `/session/evaluate`와 동일하게 `vmLoadBaseUrl` / `targetUrl`+`payload` / 둘을 함께(VM→XHR) 사용 가능합니다.

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `vmLoadBaseUrl` | string | VM 모드 | 보안 스크립트 베이스 URL |
| `targetUrl` / `payload` / `contentType` | — | XHR 모드 | XHR POST(본문·`Content-Type`은 세션 API와 동일) |
| `url` | string | X | 코드 실행 전 이동할 URL |
| `waitUntilUrlContains` | string | X | `url` 사용 시 goto 후 URL에 이 문자열이 포함될 때까지 대기 |
| `cookies` | string \| array | X | 주입할 쿠키 |
| `headers` | object | X | 추가 HTTP 헤더 |
| `timeout` | number | X | 타임아웃 (ms) |

`url`을 준 경우 응답에 `finalUrl`이 포함될 수 있습니다.

---

## Evaluate 실행 모드

서버는 요청 필드 조합에 따라 3가지 모드 중 하나로 동작합니다.

| 조합 | 모드 | 생성 함수 | 결과 형태 |
|------|------|-----------|-----------|
| `vmLoadBaseUrl` 만 | VM 단독 | `buildVmLoadCode` | `{ ok, len, t }` |
| `targetUrl` + `payload` 만 | XHR 단독 | `buildXhrPostCode` | `{ status, data }` |
| `vmLoadBaseUrl` + `targetUrl` + `payload` | VM → XHR 순차 | `buildVmLoadThenXhrPostCode` | `{ vm: { ok, len, t }, xhr: { status, data } }` |

- **`contentType`**: 생략 시 유일한 기본값 `application/json`. 대상 사이트에 맞게 자유롭게 지정.
- **`payload`**: 문자열이면 그대로 본문. 객체/배열은 JSON 계열 contentType일 때만 직렬화.
- **응답 파싱**: 응답의 `Content-Type`에 `json`이 포함되면 `JSON.parse`, 아니면 텍스트(최대 2000자).

---

## Health Check

### GET `/health`

```json
{
  "status": "ok",
  "browser": true,
  "sessions": 2,
  "headful": false
}
```

### 브라우저 모드 (헤드풀 / 헤드리스)

서버를 끄지 않고 전환하려면 **POST** `/browser/headful` — JSON 본문에 **boolean**만 허용 (`"true"` 문자열 아님).

```http
POST /browser/headful
Content-Type: application/json

{"headful": true}
```

응답 예: `{ "ok": true, "headful": true, "relaunched": true, "message": "..." }` — `relaunched`가 **false**이면 이미 같은 모드라 브라우저를 다시 띄우지 않음(세션 유지).

- 모드가 바뀌면 브라우저가 재시작되고 **열린 세션은 모두 닫힘**. 이후 `session/create`부터 다시 사용.
- `BROWSER_ADMIN_TOKEN`을 설정한 경우: `X-Browser-Admin-Token: <토큰>` 헤더 필요.

---

## 테스트 페이지

`GET /test` 로 접근 가능한 브라우저 기반 테스트 UI.

- **프리셋 모드**: 입력 필드에 URL·Payload·ContentType을 세팅하고 Run → 5단계(create→vm→xhr→cookies→destroy) 자동 실행
- **수동 모드**: 각 단계별 JSON을 직접 편집 가능 (sessionId는 자동 주입)
- **Chromium**: 기본 선택은 **헤드리스**; 디버깅 시에만 **헤드풀**. **Run Full Process** / **parallel sessions** 시 선택값으로 `POST /browser/headful` 적용. 옆 `서버: …` 문구는 실제 서버 모드(라디오와 다를 수 있음 — 새로고침 후에도 라디오는 기본 헤드리스)
- **추가 버튼**: Health Check, List Sessions, 5 parallel /health, 5 parallel sessions, Clear Log
- 비활성화: `ENABLE_TEST_PAGE=0 node server.js`

---

## 연동 예시 (Go)

```go
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
)

const nodeServer = "http://localhost:3000"

func post(path string, body map[string]interface{}) (map[string]interface{}, error) {
    b, _ := json.Marshal(body)
    resp, err := http.Post(nodeServer+path, "application/json", bytes.NewReader(b))
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()
    raw, _ := io.ReadAll(resp.Body)
    var result map[string]interface{}
    json.Unmarshal(raw, &result)
    return result, nil
}

func main() {
    // 1. 세션 생성
    createRes, _ := post("/session/create", map[string]interface{}{
        "url":     "https://bank.jejubank.co.kr:6443/inbank/websquare/serverTimeZone.wq",
        "timeout": 60000,
    })
    sessionId := createRes["sessionId"].(string)
    fmt.Println("Session:", sessionId)

    // 2. 보안 스크립트 로드
    post("/session/evaluate", map[string]interface{}{
        "sessionId":     sessionId,
        "vmLoadBaseUrl": "https://bank.jejubank.co.kr:6443/inbank/footer.do?evfw=v",
        "timeout":       60000,
    })

    // 3. JSON API 호출 (targetUrl + payload)
    ajaxRes, _ := post("/session/evaluate", map[string]interface{}{
        "sessionId": sessionId,
        "targetUrl": "https://bank.jejubank.co.kr:6443/inbank/itfc/MSOEBB081406S2.do",
        "payload": map[string]interface{}{
            "DATA":         map[string]interface{}{"iqryDiv": "K"},
            "pagingInfo":   map[string]interface{}{"pageNo": 1, "pageSize": 100},
            "ipinsideData": map[string]interface{}{"ipinsideData": "", "ipinsideNAT": "", "ipinsideCOMM": ""},
        },
        "timeout": 60000,
    })
    fmt.Println("Result:", ajaxRes)

    // 4. 세션 종료
    post("/session/destroy", map[string]interface{}{
        "sessionId": sessionId,
    })
}
```

---

## 시퀀스 다이어그램

```
Client (Go/Test Page)                    NodeServer                         Target Site
       │                                     │                                   │
       │  POST /session/create               │                                   │
       │  { url }                            │                                   │
       ├────────────────────────────────────►│                                   │
       │                                     │  puppeteer: new page → goto url   │
       │                                     ├──────────────────────────────────►│
       │  { sessionId }                      │◄──────────────────────────────────┤
       │◄────────────────────────────────────┤                                   │
       │                                     │                                   │
       │  POST /session/evaluate             │                                   │
       │  { sessionId, vmLoadBaseUrl }       │                                   │
       ├────────────────────────────────────►│                                   │
       │                                     │  page.evaluate: fetch+eval        │
       │                                     ├──────────────────────────────────►│
       │  { result: { ok, len, t } }         │◄──────────────────────────────────┤
       │◄────────────────────────────────────┤                                   │
       │                                     │                                   │
       │  POST /session/evaluate             │                                   │
       │  { sessionId, targetUrl, payload }  │                                   │
       ├────────────────────────────────────►│                                   │
       │                                     │  page.evaluate: XHR POST          │
       │                                     ├──────────────────────────────────►│
       │  { result: { status, data } }       │◄──────────────────────────────────┤
       │◄────────────────────────────────────┤                                   │
       │                                     │                                   │
       │  POST /session/destroy              │                                   │
       │  { sessionId }                      │                                   │
       ├────────────────────────────────────►│  page.close()                     │
       │  { success: true }                  │                                   │
       │◄────────────────────────────────────┤                                   │
```

---

## 설계 포인트

| 항목 | 설명 |
|------|------|
| **싱글 브라우저 인스턴스** | 서버 시작 시 1회 실행, 전체 수명 동안 재사용 |
| **세션 = 페이지** | `sessionId` 하나가 Chromium 페이지 하나에 대응 → 쿠키·로그인 유지 |
| **세션 타임아웃** | 10분 미사용 시 자동 파기, `evaluate` 호출 시 갱신 |
| **리소스 차단** | 이미지·폰트·미디어 요청 차단으로 속도 향상 |
| **자동 복구** | 브라우저 `disconnected` 시 재실행, 기존 세션 전체 정리 |
| **Graceful Shutdown** | `SIGINT`/`SIGTERM` 시 전체 정리 후 종료 |
| **코드 미노출** | 클라이언트는 URL만 전달; JS 소스가 패킷에 노출되지 않음 |
| **contentType 기본값** | `application/json` 단 하나. 폼·XML 등은 명시적 지정 |
