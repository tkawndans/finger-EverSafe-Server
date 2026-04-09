# Product Context

## 존재 이유
금융권·보험 사이트는 보안 모듈(JS)을 브라우저에서 실행해야 API 호출이 가능함.
Go(Otto)는 실제 브라우저가 아니므로 이 보안 모듈을 직접 실행할 수 없음.
→ **Puppeteer가 탑재된 Node 서버를 중간에 두어** 실제 Chromium에서 스크립트를 주입하고 XHR POST를 수행.

## 해결하는 문제
- 보안 모듈이 `eval`되어야 하는 환경에서의 API 자동화
- 로그인 세션(쿠키) 유지가 필요한 다단계 플로우
- 다양한 Content-Type(JSON, form, XML) 본문 전송
- (선택) 동일 출발 페이지에서 **여러 번 XHR**만 호출 — 세션 create/evaluate 대신 **웜 페이지** + `POST /evaluate/warm`

## VM 소스
- 운영 evaluate 경로: 서버에 배치한 **`EverSafe.txt`**(또는 `EVERSAFE_TXT_PATH`) 내용을 페이지에 주입
- `fetchVmScript`(URL에서 스크립트 다운로드)는 **테스트 등 보조 경로**에 사용

## 사용자 경험
- Go 서버 → REST 호출 → JSON 응답 수신 (간단한 HTTP 클라이언트)
- 테스트 페이지: 프리셋 모드(URL만 입력)와 수동 모드(JSON 직접 편집)로 빠른 검증; Admin 토큰·웜 버튼·**서버에 모드 적용**으로 헤드풀/웜 시나리오 지원
