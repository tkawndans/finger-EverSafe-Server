# NodeServer — Express + Puppeteer

실제 Chromium 브라우저 환경에서 JavaScript를 실행하는 Node.js 서버.  
Go 등 외부 서버에서 REST API로 호출하여 **보안 모듈(EverSafe.txt) 주입 → XHR POST → 결과 수집** 플로우를 자동화합니다.

코드는 **`server.js`**(브라우저·세션·미들웨어) · **`routes/`**(HTTP 라우트) · **`lib/`**(네비 정책, 스텔스, VM/XHR 실행)로 나뉩니다.

**Ever-Safe REST API**는 공통 경로 **`/api/v1/ever-safe`** 아래에 노출됩니다(예: `GET …/api/v1/ever-safe/health`, `POST …/api/v1/ever-safe/session/create`). 브라우저 테스트 UI만 **`/test`**, **`POST /test/extract-ut`** 등으로 같은 origin 루트에 둡니다.

---

## 목차

1. [빠른 시작](#빠른-시작)
2. [프로젝트 구조](#프로젝트-구조)
3. [운영·개발 실행 및 종료](#ops-dev-run)
4. [패킷 캡처 (Fiddler 등) — Node 아웃바운드](#fiddler-node-proxy)
5. [환경 변수](#환경-변수)
6. [API 요약](#api-요약)
7. [세션 API — 상세](#세션-api--상세)
8. [Stateless API — 상세](#stateless-api--상세)
9. [Evaluate 실행 모드](#evaluate-실행-모드)
10. [Health·웜·브라우저 API 상세](#health-check)
11. [테스트 페이지](#테스트-페이지)
12. [연동 예시 (Go)](#연동-예시-go)
13. [시퀀스 다이어그램](#시퀀스-다이어그램)
14. [Docker (Linux)](#docker-linux)
15. [Windows 개발 → Linux Docker 서버 배포](#windows-linux-docker-deploy)

---

<h2 id="프로젝트-구조">프로젝트 구조</h2>

```
NodeServer/
├── server.js              # Express 앱, 브라우저 수명, 세션 Map, createPage / gotoAndWait
├── routes/
│   ├── health.js          # GET /api/v1/ever-safe/health
│   ├── browser.js         # GET·POST /api/v1/ever-safe/browser/headful
│   ├── session.js         # /api/v1/ever-safe/session/* , POST …/evaluate
│   └── warm.js            # POST …/evaluate/warm , POST …/warm/retry
├── lib/
│   ├── evaluate.js        # executeOnPage (VM + XHR)
│   ├── warmSession.js     # 웜 페이지 상태·구성·락
│   ├── vmScript.js        # EverSafe.txt 읽기, fetchVmScript(테스트용), VM 가드 조합
│   ├── navigationPolicy.js# 페이지별 URL 접두 허용/차단, 복구 후 VM 재주입
│   ├── stealth.js         # UA·navigator 등 스텔스
│   ├── urlPrefixMatch.js  # 네비 정책 URL 매칭
│   └── xhrCapture.js      # xhrDelegateToClient 시 POST 본문 캡처·abort
├── ever-safe/EverSafe.txt # VM 주입 스크립트(필수). `EVERSAFE_TXT_PATH`로 다른 파일 지정 가능
├── test/
│   ├── index.js           # ENABLE_TEST_PAGE 시 GET /test (로컬 전용, git 제외 가능)
│   └── testPage.html
├── package.json
├── .env.example           # 로컬용 환경 변수 템플릿(git 추적). 실제 비밀은 `.env`(gitignore)
├── README.md
├── Dockerfile, docker-compose.yml
└── memory-bank/           # 프로젝트 컨텍스트 문서(로컬 전용, git 제외 가능)
```

- **`vmLoadBaseUrl` 필드**: API 호환용으로 남아 있으며, 값이 있으면 VM 단계가 실행됩니다. 스크립트 본문은 **`EverSafe.txt`**(또는 `EVERSAFE_TXT_PATH`)에서 읽으며, **해당 URL로 Node가 fetch 하지 않습니다.** (테스트용 `fetchVmScript`는 별도 경로)

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

- **Ever-Safe REST API (베이스)** → `http://localhost:3000/api/v1/ever-safe` — 이하 엔드포인트는 모두 이 접두사 뒤에 붙습니다.
- **테스트 페이지** → `http://localhost:3000/test` (API 프리픽스 없음)

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

**헤드풀(Chromium 창 표시)로 기동** — 디버깅 시에만 사용합니다. **같은 터미널 세션**에서 서버를 띄우기 직전에 설정합니다.

```powershell
# PowerShell
$env:PUPPETEER_HEADFUL = "1"
npm start
```

```bash
# bash (Linux/macOS/Git Bash 등)
PUPPETEER_HEADFUL=1 npm start
```

기본은 헤드리스입니다. 나중에 헤드리스로 돌리려면 PowerShell에서 `Remove-Item Env:PUPPETEER_HEADFUL` 하거나 새 터미널을 쓰면 됩니다.  
이미 서버가 떠 있다면 환경 변수 대신 **`POST /api/v1/ever-safe/browser/headful`** 로 전환할 수 있습니다([Health·웜·브라우저 API 상세](#health-check)).

**종료**

- 서버를 띄운 **같은 터미널**에서 **`Ctrl+C`** → `SIGINT`를 받아 세션·브라우저를 정리한 뒤 종료합니다.
- **systemd / PM2** 등으로 백그라운드에 올린 경우: 해당 도구의 stop/restart 명령을 사용합니다 (예: `pm2 stop all`, `systemctl stop nodeserver` — 서비스 이름은 환경에 맞게 지정).

### 개발·테스트 환경

```bash
npm run dev
```

`node --watch`로 **진입 파일 `server.js`** 변경 시 자동 재시작됩니다. `routes/`·`lib/` 등을 수정한 뒤 반영이 안 되면 저장 후 한 번 재시작하거나 `server.js`를 살짝 저장해 재기동하세요.

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

**Node 프로세스가 직접 `fetch` 하는 요청**(예: 테스트용 `fetchVmScript`, 기타 Node 측 HTTP)은 환경 변수만으로는 내장 `fetch`가 프록시를 타지 않는 경우가 있어, 본 프로젝트는 **`HTTP_PROXY` / `HTTPS_PROXY` 가 설정되면 `undici`의 `EnvHttpProxyAgent`로 글로벌 디스패처를 설정**합니다.  
※ **`POST /api/v1/ever-safe/session/evaluate`의 VM 단계**는 로컬 **`EverSafe.txt`를 읽어** 주입하므로, 이 단계만 놓고 보면 Node `fetch`가 대상 은행 URL로 나가지 않습니다. Fiddler로 **Chromium XHR·페이지 네비**를 보는 설정은 아래 `PUPPETEER_PROXY`를 참고하세요.

Fiddler 등 **로컬 프록시**로 Node `fetch` 트래픽을 보려면 **서버를 기동하기 전에** 아래를 **같은 PowerShell 세션**에서 설정합니다.

**Fiddler Classic 기본 프록시: `127.0.0.1:8888`** (Everywhere 등은 포트가 다를 수 있음)

```powershell
# Fiddler 실행 후, Node 서버를 띄우기 직전에 — 같은 PowerShell 세션에서:
$env:HTTP_PROXY  = "http://127.0.0.1:8888"
$env:HTTPS_PROXY = "http://127.0.0.1:8888"

# Fiddler에서 HTTPS 복호화(Decrypt HTTPS)를 켠 경우에만 — 개발 전용 (Node fetch TLS 오류 방지)
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"

# XHR(Chromium) 트래픽도 Fiddler에 보이게 — HTTP_PROXY와 별도
$env:PUPPETEER_PROXY = "http://127.0.0.1:8888"

node server.js
# 또는 npm start / npm run dev
```

시작 로그에 `[proxy] fetch() → HTTP(S)_PROXY 사용` 이 나오면 Node 측 `fetch`가 프록시를 경유하는 설정이 적용된 것입니다.

Fiddler에서 **HTTPS 복호화(Decrypt HTTPS)** 를 켰다면 **`NODE_TLS_REJECT_UNAUTHORIZED=0` 은 사실상 필수**입니다. 이 줄 없이 `HTTP_PROXY` 만 쓰면 Node 측 `fetch`(예: 스크립트를 URL에서 받는 테스트 경로)가 **인증서 오류**로 실패하고, 응답은 `500` / `fetch failed` 형태가 될 수 있습니다.

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
| `server.js` | 메인 진입 |
| `routes/`, `lib/` | HTTP 라우트·공유 로직 |
| `ever-safe/EverSafe.txt` | Docker 이미지에 포함(VM 단계 필수). 로컬과 동일 경로 |
| `test/` (`index.js`, `testPage.html`) | `ENABLE_TEST_PAGE=1` 일 때만 필요. 로컬에 두고, Docker 이미지에는 포함하지 않음(`.dockerignore`) |
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

헬스 확인: `GET http://localhost:3000/api/v1/ever-safe/health`

### 환경 변수 (컨테이너)

- `PORT` — 기본 `3000`
- `PUPPETEER_EXECUTABLE_PATH` — Dockerfile에서 `/usr/bin/chromium` 로 고정 가능
- `ENABLE_TEST_PAGE` — 운영에서는 `0` 권장(기본값 Dockerfile에 반영)
- 루트 **`docker-compose.yml`** 에 `env_file: .env` 가 있으므로, **서버에만** 두는 `.env` 가 컨테이너 환경 변수로 주입됩니다(Git에는 없음).

---

<h2 id="windows-linux-docker-deploy">Windows 개발 → Linux Docker 서버 배포</h2>

로컬은 **Windows 11**에서 편집하고, 운영은 **Ubuntu 등 Linux** 위 **Docker** 로 올리는 흐름을 기준으로 정리합니다.

### 사전 준비

| 구분 | 내용 |
|------|------|
| **소스 저장소** | GitHub **Public** 이면 서버에서 `git clone` 만으로 받을 수 있음. **Private** 이면 HTTPS(PAT) 또는 SSH 키 인증 필요. |
| **Windows** | 코드 수정·푸시에 **Git** 사용. 로컬에서 Docker 이미지를 만들어 보려면 **Docker Desktop** 설치(선택). `docker` 명령이 없으면 Desktop 미설치 또는 PATH 문제. |
| **Linux Docker 서버** | **Docker** + **Docker Compose** 플러그인. `git` 은 기본 설치 안 되어 있는 경우가 많음 → `sudo apt update && sudo apt install -y git` 등으로 설치. |
| **서버 호스트에 Node/npm/Chromium 설치** | **불필요**. 의존성·Node 버전·Chromium은 **`docker compose build` 시 Dockerfile 안**에서 처리됨. |

### 최초 배포 (서버에서)

1. **저장소 클론** (Public 예시)  
   ```bash
   cd /opt   # 원하는 경로
   git clone https://github.com/<사용자명>/<저장소명>.git
   cd <저장소명>
   ```

2. **환경 파일** — Git에는 `.env` 가 없으므로 서버에서만 생성.  
   ```bash
   cp .env.example .env
   nano .env   # BROWSER_ADMIN_TOKEN, WARM_START_URL 등 기입
   chmod 600 .env   # 권장
   ```

3. **빌드 및 기동**  
   ```bash
   docker compose up -d --build
   ```

4. **동작 확인**  
   ```bash
   curl -s http://127.0.0.1:3000/api/v1/ever-safe/health
   docker compose logs -f
   ```

5. **방화벽** — 외부에서 접속할 경우 3000(또는 사용 중인 포트) 허용.

### 이후 코드 수정 후 재배포

**Windows(개발 PC)**

```powershell
git add .
git commit -m "변경 요약"
git push
```

**Linux Docker 서버**

```bash
cd /path/to/<저장소명>
git pull
docker compose up -d --build
```

- 서버의 **`.env`는 `git pull` 로 덮어쓰이지 않음** (저장소에 포함되지 않음).
- `Dockerfile` · `package.json` · 앱 소스가 바뀌면 **`--build` 로 이미지를 다시 만드는 것**이 안전합니다.

### tar 이미지로 옮기는 방식(선택)

Git을 쓰지 않을 때만 참고. Windows 등에서 `docker save -o app.tar <이미지:태그>` 후 서버에서 `docker load -i app.tar`. 일반적으로는 **Git clone + compose** 가 단순합니다.

### 요약 표

| 단계 | 위치 | 작업 |
|------|------|------|
| 개발 | Windows | 수정 → `git push` |
| 최초 | Linux | `git clone` → `.env` 작성 → `docker compose up -d --build` |
| 갱신 | Linux | `git pull` → `docker compose up -d --build` |
| 의존성 | 이미지 내부 | `docker compose build` 시 Dockerfile·`npm ci` 로 처리 |

---

## 환경 변수

로컬에서 파일로 관리하려면 저장소 루트에 **`.env.example`을 복사해 `.env`** 를 만들고 값을 넣으면 됩니다. 서버 기동 시 `dotenv`가 `.env`를 읽습니다(파일이 없어도 동작합니다). 운영·Docker에서는 환경 변수나 시크릿 주입 방식을 그대로 쓰면 됩니다.

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3000` | 리스닝 포트 |
| `PUPPETEER_HEADFUL` | 미설정(권장) | **기본은 헤드리스.** **`1`일 때만** 시작 시 **헤드풀**. PowerShell에서 예전에 `$env:PUPPETEER_HEADFUL="1"` 을 넣었다면 **같은 터미널 세션**에 남아 있어 헤드풀로 뜰 수 있음 → `Remove-Item Env:PUPPETEER_HEADFUL` 또는 새 터미널. 서버 시작 로그에 `PUPPETEER_HEADFUL env=...` 가 출력됨. |
| `BROWSER_ADMIN_TOKEN` | 미설정 | **(1)** 설정 시 `POST /api/v1/ever-safe/browser/headful`, **`POST /api/v1/ever-safe/warm/retry`** 에 헤더 `X-Browser-Admin-Token: <값>` 필요. 미설정이면 해당 엔드포인트는 토큰 없이 호출 가능. **(2)** **`POST /api/v1/ever-safe/evaluate/warm`** 의 요청 `payload` 디코딩에도 이 값을 씁니다. **트림 후 길이가 정확히 65자**일 때만 커스텀 Base64 알파벳(64 심볼 + 패딩 1자)으로 인식되며, 그렇지 않으면 해당 API는 페이로드를 처리할 수 없습니다(아래 [evaluate/warm 페이로드 인코딩](#evaluate-warm-payload-encoding) 참고). |
| `LOG_EVALUATE_WARM_PAYLOAD` | 미설정 | `1`이면 **`/evaluate/warm` 처리 시** 디코드된 `payload` 요약과 XHR `serializeBody` 결과 미리보기를 **서버 터미널**에 출력합니다. 인증서·서명 등 민감 값이 포함될 수 있어 **디버깅 시에만** 사용하세요. |
| `ENABLE_TEST_PAGE` | (활성) | `0` 으로 설정하면 `GET /test` 비활성화 |
| `PUPPETEER_EXECUTABLE_PATH` | 미설정 | Chromium 실행 파일 **절대 경로**. Docker/Linux에서는 `/usr/bin/chromium` 등. 설정 시 로컬 `.cache/puppeteer` 탐색보다 **우선** |
| `PUPPETEER_PROXY` | 미설정 | Fiddler 등에 **Chromium XHR**까지 보이게 할 때. 예: `http://127.0.0.1:8888` → `--proxy-server` 로 적용. **`HTTP_PROXY`와 별도** (Node `fetch`용과 무관). |
| `PUPPETEER_PROXY_BYPASS` | 미설정 | 설정 시 Chromium `--proxy-bypass-list`에 전달. 특정 호스트만 프록시 제외할 때. |
| `EVERSAFE_TXT_PATH` | 미설정 | VM 스크립트 파일. **절대 경로** 또는 **프로젝트 루트 기준 상대 경로**. 미설정 시 **`ever-safe/EverSafe.txt`** |
| `PUPPETEER_DISABLE_STEALTH` | 미설정 | `1`이면 UA·webdriver 완화 등 스텔스 비활성화(디버깅용) |
| `PUPPETEER_VIEWPORT_W` / `PUPPETEER_VIEWPORT_H` | `1920` / `1080` | 새 페이지 뷰포트 크기(클램프 적용) |
| `PUPPETEER_USER_AGENT` | 미설정 | 비어 있으면 Puppeteer 기본 UA에서 Headless 표기만 정리 |
| `PUPPETEER_NAVIGATOR_LANGUAGES` | `ko-KR,ko,...` | 스텔스 스크립트에 쓸 언어 목록(쉼표 구분) |
| `PUPPETEER_NO_VM_REINJECT_AFTER_RESTORE` | 미설정 | `1`이면 네비 복구 후 EverSafe VM 자동 재주입 안 함 |

### 웜 세션 (선택)

`WARM_START_URL`을 설정하면 기동 시(및 브라우저 재시작 후) 해당 URL로 이동한 뒤 EverSafe VM을 주입하고 **웜 페이지**를 유지합니다. 이후 **`POST /api/v1/ever-safe/evaluate/warm`** 으로 같은 페이지에서 XHR 단계만 호출할 수 있습니다.

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `WARM_START_URL` | 미설정 | 설정 시 웜 활성. 기동 시 `goto` 후 VM 주입. 미설정이면 웜 비활성. |
| `WARM_VM_LOAD_BASE_URL` | (시작 URL에서 유도) | VM 메타·복구용 베이스 URL. 미설정 시 시작 URL의 `origin` + 경로 디렉터리 접두. |
| `WARM_GOTO_TIMEOUT_MS` | `60000` | 웜 구성 중 `goto`·VM 평가 타임아웃 상한(ms), 5000~600000. |
| `WARM_COOKIES` | 미설정 | `goto` 전 쿠키 문자열(세션 생성 API와 동일 형식). |
| `WARM_EXTRA_HEADERS_JSON` | 미설정 | `goto` 시 추가 헤더(JSON 객체 문자열). |
| `WARM_WAIT_UNTIL_URL_CONTAINS` | 미설정 | `goto` 후 URL에 이 문자열이 포함될 때까지 대기. |
| `WARM_NAVIGATION_BLOCKED_URL_PREFIXES` | 미설정 | 쉼표로 구분한 차단 접두(네비 정책). |
| `WARM_NAVIGATION_ALLOWED_URL_PREFIXES` | 미설정 | 쉼표로 구분한 허용 접두. |
| `WARM_VM_NAVIGATION_GUARD_JSON` | 미설정 | `execute` 의 `vmNavigationGuard` 와 동일 구조의 JSON 문자열. |
| `WARM_EXTRACT_TNK_SR` | 미설정 | `1`이면 `goto` 후 TNK_SR 추출 시도(로그에 일부 출력). |
| `WARM_EXTRACT_TNK_SR_WAIT_MS` | `0` | TNK 추출 전 추가 대기(ms), 최대 60000. |

---

## API 요약

문서에서 **`{API Base}`** 는 **`[서버 origin]/api/v1/ever-safe`** 를 뜻합니다(예: `http://localhost:3000/api/v1/ever-safe`). 아래 경로는 모두 이 베이스 **뒤에** 붙습니다.

| 엔드포인트 | 메서드 | 설명 |
|-----------|--------|------|
| `/api/v1/ever-safe/session/create` | POST | 세션(페이지) 생성, `sessionId` 반환 |
| `/api/v1/ever-safe/session/evaluate` | POST | 세션 내 코드 실행 (VM / XHR / VM→XHR) |
| `/api/v1/ever-safe/session/cookies` | POST | 세션 쿠키 조회 |
| `/api/v1/ever-safe/session/destroy` | POST | 세션 파기 |
| `/api/v1/ever-safe/session/list` | GET | 활성 세션 목록 |
| `/api/v1/ever-safe/evaluate` | POST | Stateless 단발 실행 (세션 없이) |
| `/api/v1/ever-safe/health` | GET | 서버 상태 확인 (`headful`, 웜 필드, **`warmPayloadEncodingReady`** 등) |
| `/api/v1/ever-safe/evaluate/warm` | POST | 웜 페이지에서 **XHR만** (`targetUrl`+`payload`, `url`/`vmLoadBaseUrl` 불가). **`payload`는 JSON 객체가 아니라 인코딩된 문자열**만 허용(아래 인코딩 절 참고). 웜 미준비 시 503. |
| `/api/v1/ever-safe/warm/retry` | POST | 웜 구성 재실행. `BROWSER_ADMIN_TOKEN` 설정 시 `X-Browser-Admin-Token` 필요. |
| `/api/v1/ever-safe/browser/headful` | GET | 현재 헤드풀 여부 `{ "headful": true|false }` |
| `/api/v1/ever-safe/browser/headful` | POST | 런타임 헤드풀/헤드리스 전환. 이미 같은 모드면 재시작 생략(`relaunched: false`). Body: `{ "headful": true }` |

---

## 세션 API — 상세

### 1. 세션 생성

| 항목 | 내용 |
|------|------|
| **URL** | `{API Base}/session/create` |
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
| **URL** | `{API Base}/session/evaluate` |
| **Method** | `POST` |
| **Headers** | `Content-Type: application/json` |

**Request Body — 임의 `code` 문자열은 받지 않음**

| 모드 | 사용할 필드 | 설명 |
|------|-------------|------|
| **보안 스크립트 로드** | `vmLoadBaseUrl` | 필드가 있으면 VM 단계 실행. 스크립트는 서버 디스크의 **`EverSafe.txt`**(`EVERSAFE_TXT_PATH` 가능)에서 읽어 `page.evaluate`로 주입합니다. URL 문자열은 API 호환·메타데이터용이며, **이 URL로 스크립트를 내려받지 않습니다.** |
| **POST (XHR)** | `targetUrl` + `payload` + (선택) `contentType` | 서버가 XHR 템플릿을 조립. **`contentType` 생략 시 기본값은 `application/json`**. 대상 사이트에 맞게 JSON·문자열·XML 등 본문 형식을 `payload`+`contentType`으로 맞춤. |
| **VM → XHR (순차)** | `vmLoadBaseUrl` + `targetUrl` + `payload` + (선택) `contentType` | **같은 페이지 컨텍스트**에서 먼저 EverSafe VM을 주입한 뒤, 이어서 XHR `POST`를 실행. 결과는 `{ "vm": { … }, "xhr": { "status", "data" } }` 형태. |

**필드 상세**

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `sessionId` | string | 예 | ①에서 받은 ID |
| `vmLoadBaseUrl` | string | VM 단독 또는 VM+XHR | 값이 있으면 VM 단계 실행(스크립트는 **`EverSafe.txt`**). URL은 식별·복구 메타데이터용(네트워크 fetch 아님) |
| `targetUrl` | string | XHR 단독 또는 VM+XHR | `POST`할 **전체 URL** (`https://...`) |
| `payload` | object 또는 string | XHR 단독 또는 VM+XHR | **문자열**이면 그대로 본문(XML·폼·원문 등). **객체·배열 등**은 `contentType`이 JSON 계열일 때만 `JSON.stringify`로 직렬화. JSON이 아닌 `contentType`으로 객체를 보낼 수 없음(문자열로 보낼 것). |
| `contentType` | string | 아니오 | 요청 `Content-Type` 헤더. **생략 시 `application/json`** (유일한 기본값). 예: `application/x-www-form-urlencoded`, `application/xml`, `text/xml`, `text/plain` |
| `url` | string | 아니오 | 실행 **전에** 브라우저가 이동할 URL (`page.goto`) |
| `waitUntilUrlContains` | string | 아니오 | `url`을 줄 때, goto 후 URL에 이 문자열이 포함될 때까지 대기 (`…/session/create`와 동일) |
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
| **URL** | `{API Base}/session/cookies` |
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
| **URL** | `{API Base}/session/destroy` |
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
| **URL** | `{API Base}/session/list` |
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

### POST `/api/v1/ever-safe/evaluate` — 단발성 실행

매 요청마다 새 페이지를 열고 닫습니다. 세션 **`/api/v1/ever-safe/session/evaluate`** 와 동일하게 `vmLoadBaseUrl` / `targetUrl`+`payload` / 둘을 함께(VM→XHR) 사용 가능합니다.

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `vmLoadBaseUrl` | string | VM 모드 | EverSafe VM 실행 트리거(본문은 로컬 `EverSafe.txt`) |
| `targetUrl` / `payload` / `contentType` | — | XHR 모드 | XHR POST(본문·`Content-Type`은 세션 API와 동일) |
| `url` | string | X | 코드 실행 전 이동할 URL |
| `waitUntilUrlContains` | string | X | `url` 사용 시 goto 후 URL에 이 문자열이 포함될 때까지 대기 |
| `cookies` | string \| array | X | 주입할 쿠키 |
| `headers` | object | X | 추가 HTTP 헤더 |
| `timeout` | number | X | 타임아웃 (ms) |

`url`을 준 경우 응답에 `finalUrl`이 포함될 수 있습니다.

---

## Evaluate 실행 모드

서버는 요청 필드 조합에 따라 3가지 모드 중 하나로 동작합니다. 구현은 **`lib/evaluate.js`** 의 `executeOnPage` 한 경로에서 처리합니다.

| 조합 | 모드 | 구현 요약 | 결과 형태 |
|------|------|-----------|-----------|
| `vmLoadBaseUrl` 만 | VM 단독 | `readEverSafeVmScript` → (선택) 네비 가드 prepend → `evalVmScriptInPage` | `{ ok, source, path, vmLoadBaseUrl, len, vmLen, guardLen, … }` |
| `targetUrl` + `payload` 만 | XHR 단독 | `buildXhrPostCode` → `page.evaluate` | `{ status, data }` |
| `vmLoadBaseUrl` + `targetUrl` + `payload` | VM → XHR 순차 | 위 VM 후 `postVmSettleMs`(선택) 대기 → XHR | `{ vm: { … }, xhr: { status, data } }` |

- **`contentType`**: 생략 시 유일한 기본값 `application/json`. 대상 사이트에 맞게 자유롭게 지정.
- **`payload`**: 문자열이면 그대로 본문. 객체/배열은 JSON 계열 contentType일 때만 직렬화.
- **응답 파싱**: 응답의 `Content-Type`에 `json`이 포함되면 `JSON.parse`, 아니면 텍스트(최대 2000자).

### 클라이언트가 직접 통신 (`xhrDelegateToClient`)

`targetUrl` + `payload`가 있을 때 **`xhrDelegateToClient`: `true`**(또는 `delegateXhrToClient`)를 넣으면, 브라우저에서 **실제 네트워크로 요청을 보내지 않고**, EverSafe 등이 적용한 **최종 POST 본문**을 Puppeteer `request` 훅에서 읽은 뒤 요청을 **abort**합니다. 응답 JSON의 `xhr` 필드 예시는 다음과 같습니다.

```json
{
  "delivery": "client",
  "preparedRequest": {
    "url": "https://…",
    "postData": "… EverSafe 인코딩 이후 문자열 …",
    "headers": { "content-type": "…", … }
  },
  "browser": { "status": 0, "data": … }
}
```

- **`xhrCaptureTimeoutMs`**: 캡처 대기 시간(선택, 기본은 요청 `timeout` 또는 30초 상한).
- **전제**: EverSafe가 **같은 페이지에서 `XMLHttpRequest`로** `targetUrl`로 보내는 경로여야 하며, 요청 URL은 `targetUrl`과 동일해야 매칭됩니다(쿼리 포함 정규화 비교).
- **응답 본문**: 서버·브라우저는 대상 API 응답을 받지 않으므로, 이후 통신은 **클라이언트**가 `preparedRequest.postData` 등을 사용해 직접 수행합니다(CORS·인증서 등은 클라이언트 환경에 따름).

---

<h2 id="health-check">Health·웜·브라우저 API 상세</h2>

운영 모니터링·로드밸런서 헬스체크에는 **`GET /api/v1/ever-safe/health`** 만으로도 충분합니다. 웜 기능을 쓰는 경우 같은 응답에 웜 관련 필드가 추가됩니다.

### GET `/api/v1/ever-safe/health`

**Headers**: 없음(인증 없음).

**Response (200)** — 예시:

```json
{
  "status": "ok",
  "browser": true,
  "sessions": 0,
  "headful": false,
  "warmEnabled": true,
  "warmReady": true,
  "warmLastError": null,
  "warmSetupInFlight": false,
  "warmUrl": "https://bank.jejubank.co.kr:6443/inbank/websquare/serverTimeZone.wq",
  "warmPayloadEncodingReady": true
}
```

#### 응답 필드 설명

| 필드 | 타입 | 의미 |
|------|------|------|
| `status` | string | 항상 `"ok"` (200일 때). 프로세스가 요청을 정상 처리했음을 나타냄. |
| `browser` | boolean | Puppeteer **브라우저 인스턴스가 살아 있으면** `true`. `false`면 Chromium이 아직 없거나 기동 실패 직후 등 비정상 상태. |
| `sessions` | number | **세션 API**로 열린 페이지 수(`Map` 크기). 웜 전용 페이지는 여기 **포함되지 않음**. |
| `headful` | boolean | **현재** Chromium이 **헤드풀**(창 표시)로 떠 있으면 `true`, 기본과 같이 헤드리스면 `false`. `POST /api/v1/ever-safe/browser/headful` 또는 `PUPPETEER_HEADFUL=1` 기동 시 반영. |
| `warmEnabled` | boolean | 환경 변수 **`WARM_START_URL`이 설정되어** 웜 기능이 켜져 있으면 `true`. 미설정이면 `false`. |
| `warmReady` | boolean | 웜이 켜져 있고, **웜 전용 탭**에서 `goto` + EverSafe VM 주입까지 **성공**했으면 `true`. 웜 비활성(`warmEnabled: false`)이면 항상 `false`. |
| `warmLastError` | string \| null | 마지막 웜 구성 실패 메시지. 성공 시 `null`. 브라우저 크래시 직후 등에는 `"browser disconnected"` 등이 남을 수 있음. |
| `warmSetupInFlight` | boolean | 웜 구성(`기동 직후` / `POST /api/v1/ever-safe/warm/retry` / 재연결 후)이 **진행 중**이면 `true`. 이 동안 `POST /api/v1/ever-safe/evaluate/warm`은 같은 락에서 대기. |
| `warmUrl` | string \| null | 웜이 사용하는 **시작 URL**(`WARM_START_URL`). 웜 비활성이면 `null`. |
| `warmPayloadEncodingReady` | boolean | `BROWSER_ADMIN_TOKEN` 을 **트림한 길이가 65자**이면 `true`. `POST /api/v1/ever-safe/evaluate/warm` 요청 본문의 `payload` 문자열을 서버가 디코드할 수 있는지 여부(토큰 값 자체는 노출하지 않음). |
| `warmConfigError` | boolean | (선택) 웜 관련 환경 변수(JSON 등) 파싱 오류 시에만 `true`. 정상이면 필드 자체가 없음. |

**호출 예시 (curl)**

```bash
curl -s http://localhost:3000/api/v1/ever-safe/health | jq .
```

**호출 예시 (JavaScript `fetch`)**

```javascript
const r = await fetch("http://localhost:3000/api/v1/ever-safe/health");
const j = await r.json();
console.log(j.headful, j.warmReady, j.warmUrl);
```

---

### POST `/api/v1/ever-safe/browser/headful` — 헤드리스 / 헤드풀 전환

서버를 끄지 않고 Chromium 표시 모드만 바꿉니다. **`POST /api/v1/ever-safe/warm/retry`와는 별개**입니다(웜은 URL·VM만 다시 잡음).

**Headers**

| 헤더 | 필수 | 설명 |
|------|------|------|
| `Content-Type` | 예 | `application/json` |
| `X-Browser-Admin-Token` | 조건부 | 환경 변수 **`BROWSER_ADMIN_TOKEN`** 이 설정된 경우에만 **필수**. 값은 env와 동일. |

**Request Body** — boolean만 허용(문자열 `"true"` 불가).

```json
{ "headful": true }
```

**Response (200)**

```json
{
  "ok": true,
  "headful": true,
  "relaunched": true,
  "message": "switched to headful"
}
```

| 필드 | 의미 |
|------|------|
| `ok` | 요청이 수락되었는지. |
| `headful` | 전환 **후** 현재 모드. |
| `relaunched` | `true`이면 Chromium을 **닫았다가 다시 띄움**. `false`이면 이미 같은 모드라 **재시작 없음**(세션 유지). |
| `message` | 사람이 읽기 쉬운 설명. |

- 모드가 바뀌어 재시작되면 **열린 세션은 모두 무효** → `…/session/create`부터 다시 사용.
- 재시작 후 웜이 켜져 있으면 서버가 **웜 구성을 자동으로 다시** 수행합니다.

**curl 예시 (토큰 사용 시)**

```bash
curl -s -X POST http://localhost:3000/api/v1/ever-safe/browser/headful \
  -H "Content-Type: application/json" \
  -H "X-Browser-Admin-Token: YOUR_TOKEN" \
  -d "{\"headful\":true}"
```

---

### POST `/api/v1/ever-safe/evaluate/warm` — 웜 페이지에서 XHR만

<a id="evaluate-warm-payload-encoding"></a>

**전제**: `WARM_START_URL` 설정 + `warmReady: true`. VM·`goto`는 이미 웜 구성에서 끝난 상태이므로, 이 API는 **`targetUrl` + `payload`** 로 **XHR 단계만** 실행합니다(`lib/evaluate.js`의 XHR 경로와 동일).

**Headers**: `Content-Type: application/json` — **`X-Browser-Admin-Token`은 필요 없음**(웜 XHR 본문과 별개).

**Request Body** — `url`, `vmLoadBaseUrl` 을 넣으면 **400** (웜 전용 규칙).

| 필드 | 필수 | 설명 |
|------|------|------|
| `targetUrl` | 예* | XHR POST 대상 URL. |
| `payload` | 예* | **반드시 문자열**이어야 합니다. JSON 객체·배열·숫자 등은 **400**입니다. 문자열 내용은 아래 **커스텀 Base64**로 인코딩된 값이며, 서버가 디코드한 뒤 `JSON.parse` 하여 XHR 본문 객체로 사용합니다. **세션** `POST …/session/evaluate` 의 `payload`(객체 허용)와 규칙이 다릅니다. |
| `contentType` | 아니오 | 기본 `application/json`. |
| `timeout` | 아니오 | ms. 기본 30000. |
| `xhrDelegateToClient` 등 | 아니오 | 세션 evaluate와 동일(본문 캡처 모드 등). |

\* `executeOnPage` 조건상 둘 다 필요.

#### 통신 구간: `evaluate/warm` 페이로드 인코딩·디코딩

운영에서는 **HTTP JSON 본문의 `payload` 필드**만 암호화 구간으로 두고, 나머지 필드(`targetUrl`, `timeout` 등)는 평문 JSON입니다.

| 단계 | 위치 | 동작 |
|------|------|------|
| **인코딩(클라이언트)** | 연동 앱·브라우저 | **JSON 객체**면 `JSON.stringify` 한 문자열을, **`logSgnt=…&cert=…` 같은 폼 문자열**이면 그 UTF-8 원문을 **UTF-8 옥텟**으로 변환한 뒤(`stringToUtf8Bytes`), **65자 알파벳**(앞 64자 데이터 + 65번째 패딩)으로 Base64형 4문자 블록 인코딩합니다. 알파벳은 서버 **`BROWSER_ADMIN_TOKEN`** 과 동일(공백·개행 제거 후 길이 65자). |
| **디코딩(서버)** | `lib/payloadCustomBase64.js` | `decodeCustomBase64`로 옥텟을 복원한 뒤, `{`(0x7B)부터 **UTF-8 디코드**하여 문자열을 만듭니다. 맨 앞이 `{`/`[` 인 JSON 문서만 검증 후 그대로 쓰고, 그 외(폼 평문 등)는 **UTF-8 복원 문자열을 추가 URL 디코드 없이** 반환합니다. `prepareEvaluateWarmBody`에서도 `{`/`[` 로 시작할 때만 `JSON.parse` 하여 객체로 쓰고, 아니면 **문자열 그대로** `payload`로 전달합니다. |
| **알파벳 길이** | env | `BROWSER_ADMIN_TOKEN` 을 **트림했을 때 정확히 65자**가 아니면 서버는 페이로드를 처리하지 않습니다. `GET …/health` 의 **`warmPayloadEncodingReady`** 가 이 조건을 만족하는지 여부를 나타냅니다. |

**참고 구현**

- **Node(서버·검증용)**: `lib/payloadCustomBase64.js` — `stringToUtf8Bytes`, `utf8BytesToString`, `encodeCustomBase64`, `decodeCustomBase64`, `prepareEvaluateWarmBody`, `ALPHABET_LEN`(`65`).
- **ES5(레거시 웹뷰 등)**: `docs/nodeWarmHelper.es5.js` — `nodeWarm_encodeCustomBase64`, `nodeSession_run` 이 `evaluate/warm` 호출 전에 동일 규칙으로 인코딩합니다. 알파벳은 `NODE_BROWSER_ADMIN_TOKEN` / `config.adminToken`(서버 토큰과 동일 값).
- **테스트 페이지** (`GET /test`): 기본은 위 규칙으로 인코딩 후 전송. **「인코딩 없이 전송」** 체크 시 평문 문자열을 보내 **디코드·파싱 오류(400)** 를 재현할 수 있습니다.

**Response (200)**

```json
{
  "result": { "status": 200, "data": { } },
  "finalUrl": "https://..."
}
```

| 필드 | 의미 |
|------|------|
| `result` | XHR 완료 결과(또는 VM+XHR 조합이 아닌 **XHR 단독**과 같은 형태). `xhrDelegateToClient` 사용 시 구조는 [Evaluate 실행 모드](#evaluate-실행-모드) 참고. |
| `finalUrl` | 요청 처리 직후 웜 페이지의 `page.url()` (가능할 때만). |

**오류**

| HTTP | 조건 |
|------|------|
| 400 | `url` / `vmLoadBaseUrl` 포함, `payload`가 문자열이 아님, 디코드 실패, `BROWSER_ADMIN_TOKEN` 길이 불일치 등. 응답 메시지는 운영에서 추측을 줄이도록 일반화되어 있을 수 있음. |
| 503 | 웜 비활성, 또는 `warmReady` 아님, 구성 진행 중 등. |

**`fetch` 예시** — 클라이언트에서 **먼저** 평문( `JSON.stringify(객체)` 또는 `logSgnt=…&cert=…` 등)을 `encodeCustomBase64(plain, alphabet)` 로 인코딩한 뒤 `payload`로 보냅니다. (인코더는 `lib/payloadCustomBase64.js` 와 동일 알고리즘이어야 합니다.) 폼 본문 XHR이면 요청에 **`contentType`: `application/x-www-form-urlencoded; charset=UTF-8`** 를 맞추세요.

```javascript
const { encodeCustomBase64 } = require("./lib/payloadCustomBase64"); // Node 연동 예시

const plainObject = { key: "value" };
const alphabet = process.env.BROWSER_ADMIN_TOKEN.trim();
if (alphabet.length !== 65) throw new Error("BROWSER_ADMIN_TOKEN must be 65 chars after trim");

const encodedPayload = encodeCustomBase64(JSON.stringify(plainObject), alphabet);

const r = await fetch("http://localhost:3000/api/v1/ever-safe/evaluate/warm", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    targetUrl: "https://example.com/api",
    payload: encodedPayload,
    timeout: 60000,
  }),
});
const j = await r.json();
```

---

### POST `/api/v1/ever-safe/warm/retry` — 웜 구성 다시 실행

`WARM_START_URL`로 다시 `goto` 한 뒤 EverSafe VM을 다시 주입합니다. **헤드리스/헤드풀 전환은 하지 않습니다.**

**Headers**

| 헤더 | 필수 |
|------|------|
| `Content-Type` | 예 |
| `X-Browser-Admin-Token` | `BROWSER_ADMIN_TOKEN` 설정 시 필수 |

**Request Body**: `{}` 가능(추가 필드 없음).

**Response (200)** — 성공 시 예:

```json
{
  "ok": true,
  "state": {
    "warmEnabled": true,
    "warmReady": true,
    "warmLastError": null,
    "warmSetupInFlight": false,
    "warmUrl": "https://..."
  }
}
```

| 필드 | 의미 |
|------|------|
| `ok` | 웜 구성이 이번 호출에서 성공했는지. |
| `state` | 직후 `GET /api/v1/ever-safe/health`와 동일한 웜 관련 필드 스냅샷. |

**오류**: `WARM_START_URL` 미설정 시 **400**, 구성 실패 시 **500**, 동시에 다른 웜 작업 중이면 **429**.

---

## 테스트 페이지

`GET /test` 로 접근 가능한 브라우저 기반 테스트 UI.

- **프리셋 모드**: 입력 필드에 URL·Payload·ContentType을 세팅하고 Run → 5단계(create→vm→xhr→cookies→destroy) 자동 실행
- **수동 모드**: 각 단계별 JSON을 직접 편집 가능 (sessionId는 자동 주입)
- **Admin 토큰**: 입력 시 `POST /api/v1/ever-safe/browser/headful`, `POST /api/v1/ever-safe/warm/retry` 등에 `X-Browser-Admin-Token`으로 전달됨. **서버 `BROWSER_ADMIN_TOKEN`과 동일한 65자**이면 `Warm: POST …/evaluate/warm` 기본 동작에서 **페이로드 커스텀 Base64 인코딩 알파벳**으로도 사용됨([인코딩 설명](#evaluate-warm-payload-encoding))
- **Chromium**: 기본 선택은 **헤드리스**; 디버깅 시 **헤드풀** 선택 후 **`서버에 모드 적용`** 버튼으로 `POST /api/v1/ever-safe/browser/headful`만 호출 가능(라디오만으로는 서버가 안 바뀜). 옆 `서버: headless|headful` 은 `GET /api/v1/ever-safe/health`의 `headful`과 동기화
- **웜 테스트** (`WARM_START_URL` 설정 시): `Warm: GET …/health`, `Warm: POST …/evaluate/warm`, `Warm: POST …/warm/retry` — `warm/retry`는 헤드풀 전환이 **아님**(웜 URL·VM만 재구성). `evaluate/warm` 은 기본적으로 ③ JSON을 인코딩해내며, **「인코딩 없이 전송」** 으로 서버 오류 경로를 재현할 수 있음
- **기타 버튼**: Health Check, List Sessions, 5 parallel …/health, 5 parallel sessions, **`POST /test/extract-ut`**(API 프리픽스 없음), Clear Log
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

const nodeServer = "http://localhost:3000/api/v1/ever-safe"

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

### 웜 API (선택) — Health 확인 후 `/api/v1/ever-safe/evaluate/warm`

`WARM_START_URL`을 쓰는 경우, 주기적으로 `GET …/health`로 `warmReady`·**`warmPayloadEncodingReady`** 를 확인한 뒤 XHR만 보냅니다.

`evaluate/warm` 의 **`payload`는 JSON 객체가 아니라, `JSON.stringify` 후 커스텀 Base64로 만든 문자열**이어야 합니다([인코딩 설명](#evaluate-warm-payload-encoding)). Go에서는 Node의 `encodeCustomBase64` 와 동일 알고리즘을 이식하거나, 사전에 인코딩한 문자열을 `post`에 넘깁니다.

```go
// GET /api/v1/ever-safe/health — warmReady, warmPayloadEncodingReady 확인
resp, _ := http.Get("http://localhost:3000/api/v1/ever-safe/health")
// ... json.Unmarshal → warmReady, warmPayloadEncodingReady, warmUrl

// POST …/evaluate/warm — X-Browser-Admin-Token 헤더 불필요. payload 는 "인코딩된 문자열"만.
payloadJSON := map[string]interface{}{
    "DATA": map[string]interface{}{"iqryDiv": "K"},
}
// encoded := encodeWarmPayloadMustMatchNode(payloadJSON, os.Getenv("BROWSER_ADMIN_TOKEN")) // 65자 알파벳, lib/payloadCustomBase64.js 와 동일
var encoded string // 실제로는 위 인코딩 결과

warmRes, _ := post("/evaluate/warm", map[string]interface{}{
    "targetUrl": "https://bank.jejubank.co.kr:6443/inbank/itfc/MSOEBB081406S2.do",
    "payload":   encoded,
    "timeout":   60000,
})
fmt.Println("warm:", warmRes)

// POST …/warm/retry — 웜만 재구성. BROWSER_ADMIN_TOKEN 이 있으면 헤더 필요(위 post()는 헤더 미포함이므로 별도 구현)
```

운영 코드에서는 `post()`에 `X-Browser-Admin-Token`을 조건부로 붙이거나, **`/api/v1/ever-safe/warm/retry`** 전용 `http.NewRequest`를 쓰면 됩니다.

---

## 시퀀스 다이어그램

```
Client (Go/Test Page)                    NodeServer                         Target Site
       │                                     │                                   │
       │  POST …/api/v1/ever-safe/session/create │                               │
       │  { url }                            │                                   │
       ├────────────────────────────────────►│                                   │
       │                                     │  puppeteer: new page → goto url   │
       │                                     ├──────────────────────────────────►│
       │  { sessionId }                      │◄──────────────────────────────────┤
       │◄────────────────────────────────────┤                                   │
       │                                     │                                   │
       │  POST …/ever-safe/session/evaluate  │                                   │
       │  { sessionId, vmLoadBaseUrl }       │                                   │
       ├────────────────────────────────────►│                                   │
       │                                     │  EverSafe.txt → page.evaluate(eval)│
       │                                     ├──────────────────────────────────►│
       │  { result: { ok, source, path… } }  │◄──────────────────────────────────┤
       │◄────────────────────────────────────┤                                   │
       │                                     │                                   │
       │  POST …/ever-safe/session/evaluate  │                                   │
       │  { sessionId, targetUrl, payload }  │                                   │
       ├────────────────────────────────────►│                                   │
       │                                     │  page.evaluate: XHR POST          │
       │                                     ├──────────────────────────────────►│
       │  { result: { status, data } }       │◄──────────────────────────────────┤
       │◄────────────────────────────────────┤                                   │
       │                                     │                                   │
       │  POST …/ever-safe/session/destroy   │                                   │
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
| **라우트 분리** | `routes/health.js`, `browser.js`, `session.js`, `warm.js` — `server.js`는 등록·의존성 주입 |
| **웜 세션** | `lib/warmSession.js` — `WARM_START_URL` 시 전용 페이지에 goto+VM, `POST /api/v1/ever-safe/evaluate/warm`(XHR만), `POST /api/v1/ever-safe/warm/retry` |
| **evaluate/warm 페이로드** | JSON 본문의 `payload`만 **커스텀 Base64 문자열** 허용. 디코드 후 **JSON 객체** 또는 **`logSgnt=…` 등 평문 문자열**. `BROWSER_ADMIN_TOKEN`(트림 65자)이 알파벳. `lib/payloadCustomBase64.js` — [상세](#evaluate-warm-payload-encoding) |
| **네비게이션 정책** | `lib/navigationPolicy.js` — URL 접두 허용/차단, 위반 시 복구·(선택) VM 재주입 |
| **리소스 차단** | 이미지·폰트·미디어 요청 차단으로 속도 향상 |
| **자동 복구** | 브라우저 `disconnected` 시 재실행, 기존 세션 전체 정리 |
| **Graceful Shutdown** | `SIGINT`/`SIGTERM` 시 전체 정리 후 종료 |
| **VM 소스** | evaluate VM은 로컬 **`EverSafe.txt`** — 요청으로 임의 JS 문자열을 받지 않음 |
| **contentType 기본값** | `application/json` 단 하나. 폼·XML 등은 명시적 지정 |
