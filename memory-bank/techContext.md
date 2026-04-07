# Tech Context

## 기술 스택
- **Runtime**: Node.js 18+ (--watch 플래그 지원)
- **Framework**: Express 5
- **Browser Automation**: Puppeteer (Chromium 번들)

## 의존성
- `express` ^5.2.1 — 웹 서버 프레임워크
- `puppeteer` ^24.40.0 — Chromium 브라우저 자동화

## 파일 구조
```
NodeServer/
├── server.js          # 메인 서버 (Express + Puppeteer)
├── test.js            # 테스트 라우트 등록 (GET /test)
├── test/
│   └── testPage.html  # 브라우저 테스트 UI (프리셋/수동 모드)
├── package.json
├── README.md
├── Dockerfile
├── memory-bank/       # 프로젝트 컨텍스트 문서
└── .cache/puppeteer/  # Chromium 바이너리 캐시
```

## 개발 환경
- OS: Windows 10+
- Chromium: `.cache/puppeteer/chrome/` 내 자동 탐색 (`findChromePath`)
- --no-sandbox 필수 (Windows 환경)
- Puppeteer **기본 헤드리스**; 헤드풀은 필요 시만(테스트 페이지 라디오 또는 `POST /browser/headful`, 또는 시작 시 `PUPPETEER_HEADFUL=1`)
- Docker/Linux: `Dockerfile` + `PUPPETEER_EXECUTABLE_PATH` (apt `chromium`). `PUPPETEER_EXECUTABLE_PATH`가 있으면 Windows용 `findChromePath`보다 우선

## 기술적 제약
- `page.evaluate()` 반환값은 직렬화 가능해야 함 (DOM 노드 직접 반환 불가)
- Express 5에서 `app.options("*")` 대신 CORS 미들웨어로 처리
- XHR 응답 텍스트 최대 2000자로 제한 (메모리 보호)
