# Progress

## 완료된 항목
- [x] Express + Puppeteer 기반 세션 API + Stateless API + Health + 브라우저 헤드풀 전환
- [x] VM: 로컬 **`EverSafe.txt`** 주입 (`EVERSAFE_TXT_PATH` 지원)
- [x] XHR POST (`targetUrl` + `payload` + `contentType`)
- [x] VM → XHR 순차 (`executeOnPage`)
- [x] 네비게이션 정책·복구·스텔스 (`lib/navigationPolicy`, `lib/stealth`)
- [x] **`lib/` 모듈 분리** — evaluate / vmScript / navigation / stealth / urlPrefixMatch
- [x] **`routes/` 분리** — health, browser, session
- [x] `undici` + `HTTP(S)_PROXY` — Node `fetch` 프록시
- [x] README — API, EverSafe, 구조, 환경 변수, Docker 포함 파일
- [x] 메모리뱅크 — 현재 구조 반영

## 남은 항목 (선택)
- [ ] 실제 대상 사이트 회귀 테스트
- [ ] Go Otto 연동 테스트
- [ ] 동시성 제한 / 세션 수 상한

## 알려진 이슈 / 참고
- `npm run dev`는 **`server.js`만 watch** — `lib/`·`routes/` 수정 후 반영이 안 되면 수동 재시작
- Windows Chrome 캐시 경로에 의존하는 자동 탐색은 배포 환경과 다를 수 있음 → Docker에서는 `PUPPETEER_EXECUTABLE_PATH` 권장
