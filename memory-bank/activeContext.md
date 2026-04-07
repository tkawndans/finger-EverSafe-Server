# Active Context

## 현재 상태
- server.js 완전 재작성 완료 (깔끔한 구조, undici/xhrViaNode 제거)
- 모든 API 테스트 통과 (health, session CRUD, evaluate, stateless, browser mode)

## 최근 변경사항 (2026-04-06)
- server.js 처음부터 재작성: 불필요한 xhrViaNode/undici 코드 완전 제거
- XHR은 브라우저 page.evaluate 내 XMLHttpRequest만 사용
- `runResolved` 헬퍼로 evaluate 분기 단순화 (split → executeVmThenXhr, 단일 → executeCode)
- testPage.html: VM+XHR 동시에 있으면 **한 번의** `/session/evaluate`로 VM→XHR 순차 실행
- package.json에서 undici 의존성 제거
- `waitUntilUrlContains`: goto 후 URL 폴링 대기 유지
- create/evaluate 응답에 `finalUrl` 포함 유지
- `contentType` 필드 지원 (기본값 `application/json`) 유지
- 응답 파싱: 응답 Content-Type 헤더 기준 JSON/텍스트 분기 유지

## 다음 단계
- 실제 서버 실행 및 대상 사이트 테스트 (제주은행, 보험개발원)
- Go Otto에서의 세션 연동 테스트
- 필요 시 동시성 제한, 세션 수 제한 추가

## 활성 결정사항
- 임의 `code` 필드 실행은 보안상 차단 → URL 기반 템플릿만 허용
- `vmLoadBaseUrl` + `targetUrl` + `payload` 동시 전송 시 VM→XHR 순차 실행
- Node fetch(xhrViaNode) 경로 완전 제거 — 브라우저 내 XHR만 사용
- Git 미사용 중 (추후 초기화 권장)
