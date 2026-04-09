# Project Brief

## 개요
Go 기반 외부 서버(Otto) 등에서 REST API로 호출하여 **실제 Chromium 브라우저 환경**에서 JavaScript를 실행하는 Node.js 중간 서버.

엔트리는 **`server.js`**(브라우저 수명·세션·미들웨어·라우트 등록), HTTP 핸들러는 **`routes/`**, 공유 도메인 로직은 **`lib/`**에 둔다.

## 핵심 목표
1. 보안 모듈이 필요한 금융권 사이트 등의 API를 **브라우저 세션 유지** 상태에서 자동 호출
2. 클라이언트에 **임의 JS 소스 문자열을 보내지 않음** — evaluate VM은 로컬 **`EverSafe.txt`**만 주입
3. JSON, form-urlencoded, XML 등 다양한 Content-Type의 payload를 유연하게 처리
4. (선택) **`WARM_START_URL`** 로 **웜 페이지**를 기동 시 유지하고, **`POST /evaluate/warm`** 으로 동일 탭에서 XHR만 반복 호출

## 핵심 요구사항
- 세션 기반 API: create → evaluate(VM/XHR/VM+XHR) → cookies → destroy
- Stateless 단발 실행 API: `POST /evaluate`
- 웜(선택): 환경 변수 기반 웜 구성 → `POST /evaluate/warm`(XHR만), `POST /warm/retry`, `GET /health`에 웜 필드
- 브라우저 모드: `POST /browser/headful`, 선택적 **`BROWSER_ADMIN_TOKEN`**
- 로컬 비밀: **`.env`** + **`dotenv`**(gitignore), 템플릿은 **`.env.example`**
- 프리셋/수동 모드를 갖춘 브라우저 테스트 페이지 (`test.js`, `ENABLE_TEST_PAGE`)
- `contentType` 필드 지원 (기본값 `application/json` 하나 유지)
- API에서 `vmLoadBaseUrl` 필드가 있으면 VM 단계 실행(스크립트는 **파일**에서 읽음; URL은 호환·메타데이터용)
