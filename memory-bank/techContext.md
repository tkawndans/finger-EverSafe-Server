# Tech Context

## 기술 스택
- **Runtime**: Node.js 18+ (`npm run dev`는 `node --watch server.js` — 진입 파일 기준)
- **Framework**: Express 5
- **Browser Automation**: Puppeteer (Chromium 번들 또는 `PUPPETEER_EXECUTABLE_PATH`)
- **HTTP 클라이언트(프록시)**: `undici` — `HTTP(S)_PROXY` 설정 시 `EnvHttpProxyAgent`로 글로벌 `fetch` 디스패처
- **로컬 환경 변수**: `dotenv` — 프로젝트 루트 `.env` (gitignore), `.env.example` 템플릿

## 의존성 (`package.json`)
- `express` ^5.2.1
- `puppeteer` ^24.40.0
- `undici` ^6.21.3 — Node 측 `fetch` 프록시 일원화(테스트용 `fetchVmScript` 등)
- `dotenv` ^16.x — `server.js` 최상단 `require("dotenv").config()`

## 파일 구조
```
NodeServer/
├── server.js
├── routes/
│   ├── health.js
│   ├── browser.js
│   ├── session.js
│   └── warm.js
├── lib/
│   ├── evaluate.js
│   ├── warmSession.js
│   ├── vmScript.js
│   ├── navigationPolicy.js
│   ├── stealth.js
│   ├── urlPrefixMatch.js
│   └── xhrCapture.js
├── ever-safe/EverSafe.txt
├── test.js
├── test/testPage.html
├── package.json
├── .env.example
├── README.md
├── Dockerfile, docker-compose.yml
├── memory-bank/
└── .cache/puppeteer/       # 로컬 Chromium 캐시(Windows 경로 탐색)
```

## 개발 환경
- OS: Windows 10+ (리포 기준), Docker/Linux 배포 지원
- Chromium: `PUPPETEER_EXECUTABLE_PATH` 우선, 없으면 `.cache/puppeteer/chrome/` 자동 탐색(Windows `chrome-win64`)
- Puppeteer 기본 헤드리스; 헤드풀은 `PUPPETEER_HEADFUL=1` 또는 `POST /browser/headful`

## 기술적 제약
- `page.evaluate()` 반환값은 직렬화 가능해야 함
- CORS: `app.options("*all", …)` 등 Express 5 호환 패턴
- XHR 응답 텍스트 최대 2000자로 잘라 저장(`lib/evaluate.js`의 `buildXhrPostCode`)
