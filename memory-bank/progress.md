# Progress

## 완료된 항목
- [x] 프로젝트 초기화 (npm init, express, puppeteer 설치)
- [x] server.js 구현 — 세션 API + Stateless API + Health
- [x] VM 로드 모드 (`vmLoadBaseUrl`)
- [x] XHR POST 모드 (`targetUrl` + `payload`)
- [x] VM → XHR 순차 모드 (`vmLoadBaseUrl` + `targetUrl` + `payload`)
- [x] `contentType` 필드 지원 (기본값 `application/json`)
- [x] `serializeXhrBody` — 문자열 payload 그대로 / JSON contentType일 때만 직렬화
- [x] 응답 파싱: 응답 Content-Type 헤더 기준 JSON/텍스트 분기
- [x] test.js — 테스트 라우트 등록
- [x] testPage.html — 프리셋 모드 + 수동 모드 + 병렬 테스트 버튼
- [x] README.md — 전체 API 문서, 예시, Go 연동, 시퀀스 다이어그램
- [x] CORS 미들웨어 (Express 5 호환)
- [x] findChromePath — 로컬 .cache/puppeteer 캐시에서 Chrome 자동 탐색
- [x] 리소스 차단, 세션 타임아웃, Graceful Shutdown
- [x] 메모리뱅크 파일 전체 작성
- [x] server.js 재작성 — xhrViaNode/undici 제거, 깔끔한 구조
- [x] 전체 API 테스트 통과 (health, session CRUD, evaluate, stateless, browser mode)

## 남은 항목
- [ ] 실제 대상 사이트 테스트 (제주은행, 보험개발원)
- [ ] Go Otto 연동 테스트
- [ ] Git 저장소 초기화 (현재 미사용 — 사고 방지를 위해 권장)
- [ ] 동시성 제한 / 세션 수 제한 (필요 시)

## 알려진 이슈
- Git 미사용으로 Undo All 사고 시 복구 불가 → git init 권장
- Windows에서 Puppeteer Chrome 경로 자동 탐색은 `.cache/puppeteer/chrome/` 구조에 의존
