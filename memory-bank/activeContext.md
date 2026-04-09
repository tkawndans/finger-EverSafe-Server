# Active Context

## 현재 상태 (2026-04)
- **`server.js`**: Chromium 경로·브라우저 수명·세션 Map·`createPage` / `gotoAndWait`·Express 미들웨어·라우트 등록; 기동·재연결·헤드풀 전환 후 **웜 재구성**(`scheduleWarmAfterLaunch`)
- **`routes/`**: `health.js`, `browser.js`, `session.js`, **`warm.js`** (`POST /evaluate/warm`, `POST /warm/retry`)
- **`lib/`**: `evaluate.js`, **`warmSession.js`**, `vmScript.js`, `navigationPolicy.js`, `stealth.js`, `urlPrefixMatch.js`, `xhrCapture.js`
- VM 주입: **`EverSafe.txt`** 기반; API 필드 `vmLoadBaseUrl`는 트리거·메타데이터(네트워크로 스크립트 fetch하지 않음)
- **환경**: 루트 **`.env`** 로컬 로드(`dotenv`), **`.env.example`** 템플릿; **`BROWSER_ADMIN_TOKEN`**, **`WARM_*`**

## 최근 작업
- **웜 세션**: `WARM_START_URL` 시 전용 페이지에 goto+VM, `GET /health` 웜 필드, `POST /evaluate/warm`, `POST /warm/retry`(Admin 토큰 조건부)
- 테스트 페이지: Admin 토큰, **서버에 모드 적용**, 웜 전용 버튼
- README: Health 응답 필드 설명, 웜·브라우저 API 예제(curl/fetch/Go)
- 메모리뱅크 동기화

## 다음 단계 (선택)
- 실제 대상 사이트 회귀 테스트 (제주은행, 보험개발원 등)
- Go Otto 연동 테스트
- 필요 시 동시성 제한·세션 수 상한
- (장기) API body 암·복호화에 `BROWSER_ADMIN_TOKEN` 재사용 검토

## 활성 결정사항
- 임의 `code` 문자열 실행 금지 — VM은 파일만
- `vmLoadBaseUrl` + `targetUrl` + `payload` 시 같은 페이지에서 VM → XHR 순차
- **`/evaluate/warm`** 은 `url`/`vmLoadBaseUrl` **금지**, XHR 필드만
- **`/warm/retry`** 는 헤드리스/헤드풀 전환 **아님** — `POST /browser/headful` 별도
- XHR은 브라우저 `page.evaluate` 내 XMLHttpRequest만 사용
- `HTTP(S)_PROXY` 설정 시 Node `fetch`용 **undici** 글로벌 디스패처(테스트용 fetch 등)
