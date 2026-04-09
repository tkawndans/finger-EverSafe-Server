# Progress

## 완료된 항목
- [x] Express + Puppeteer 기반 세션 API + Stateless API + Health + 브라우저 헤드풀 전환
- [x] VM: 로컬 **`EverSafe.txt`** 주입 (`EVERSAFE_TXT_PATH` 지원)
- [x] XHR POST (`targetUrl` + `payload` + `contentType`)
- [x] VM → XHR 순차 (`executeOnPage`)
- [x] 네비게이션 정책·복구·스텔스 (`lib/navigationPolicy`, `lib/stealth`)
- [x] **`lib/` 모듈 분리** — evaluate / vmScript / navigation / stealth / urlPrefixMatch / xhrCapture
- [x] **`routes/` 분리** — health, browser, session, **warm**
- [x] **`lib/warmSession.js`** — 웜 상태, 기동·재시작·락, `POST /evaluate/warm`, `POST /warm/retry`
- [x] **`dotenv`** + `.env` / `.env.example` — 로컬 비밀·`BROWSER_ADMIN_TOKEN`·`WARM_*`
- [x] `undici` + `HTTP(S)_PROXY` — Node `fetch` 프록시
- [x] README — API, EverSafe, 구조, 환경 변수, **Health 필드 설명**, 웜·브라우저 예제, Docker 포함 파일
- [x] 테스트 페이지 — Admin 토큰, 서버에 모드 적용, 웜 버튼
- [x] 메모리뱅크 — 현재 구조 반영

## 남은 항목 (선택)
- [ ] 실제 대상 사이트 회귀 테스트
- [ ] Go Otto 연동 테스트
- [ ] 동시성 제한 / 세션 수 상한
- [ ] 외부 클라이언트와 API body 암·복호화(공유 키) 구현 시 설계 확정

## 알려진 이슈 / 참고
- `npm run dev`는 **`server.js`만 watch** — `lib/`·`routes/` 수정 후 반영이 안 되면 수동 재시작
- Windows Chrome 캐시 경로에 의존하는 자동 탐색은 배포 환경과 다를 수 있음 → Docker에서는 `PUPPETEER_EXECUTABLE_PATH` 권장
- 테스트 UI에서 헤드풀 라디오만 켠다고 서버 모드가 바뀌지 않음 → **서버에 모드 적용** 또는 Run Full Process 등
