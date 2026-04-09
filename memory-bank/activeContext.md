# Active Context

## 현재 상태 (2026-04)
- **`server.js`**: Chromium 경로·브라우저 수명·세션 Map·`createPage` / `gotoAndWait`·Express 미들웨어·라우트 등록만 담당(슬림)
- **`routes/`**: `health.js`, `browser.js`, `session.js` — HTTP 엔드포인트 분리
- **`lib/`**: `evaluate.js`(executeOnPage), `vmScript.js`(EverSafe·fetchVmScript), `navigationPolicy.js`, `stealth.js`, `urlPrefixMatch.js`
- VM 주입: **`EverSafe.txt`** 기반; API 필드 `vmLoadBaseUrl`는 트리거·메타데이터(네트워크로 스크립트 fetch하지 않음)

## 최근 작업
- 모노리식 `server.js`에서 lib 모듈로 분리 후, **라우트를 `routes/`로 이동**
- README·메모리뱅크를 현재 구조·EverSafe 동작에 맞게 정리

## 다음 단계 (선택)
- 실제 대상 사이트 회귀 테스트 (제주은행, 보험개발원 등)
- Go Otto 연동 테스트
- 필요 시 동시성 제한·세션 수 상한

## 활성 결정사항
- 임의 `code` 문자열 실행 금지 — VM은 파일만
- `vmLoadBaseUrl` + `targetUrl` + `payload` 시 같은 페이지에서 VM → XHR 순차
- XHR은 브라우저 `page.evaluate` 내 XMLHttpRequest만 사용
- `HTTP(S)_PROXY` 설정 시 Node `fetch`용 **undici** 글로벌 디스패처(테스트용 fetch 등)
