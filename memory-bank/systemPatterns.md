# System Patterns

## 아키텍처

### 세션 모드 (로그인 필요 시)
```
[Client] → POST /session/create   → 페이지 생성, sessionId 반환
         → POST /session/evaluate  → 같은 페이지에서 실행 (쿠키/세션 유지)
         → POST /session/evaluate  → 로그인 상태 유지
         → POST /session/destroy   → 페이지 닫기
```

### Stateless 모드 (단발성)
```
[Client] → POST /evaluate → 새 페이지 → 실행 → 페이지 닫기
```

### 웜 모드 (선택, `WARM_START_URL`)
```
[Server start or browser relaunch] → warmSession.setupWarm → 전용 page: goto + VM
[Client] → POST /evaluate/warm → 동일 page에서 XHR만 (executeOnPage, url/vmLoadBaseUrl 금지)
[Client] → POST /warm/retry    → 웜 재구성 (Admin 토큰 조건부; 헤드풀 전환 아님)
```

### 코드 레이어
| 영역 | 책임 |
|------|------|
| `server.js` | Puppeteer 브라우저, 세션 TTL, CORS, 라우트 등록, 웜 훅(기동·disconnect·헤드풀 전환 후) |
| `routes/*.js` | HTTP 핸들러만 |
| `lib/evaluate.js` | `executeOnPage`: VM(EverSafe) + XHR |
| `lib/warmSession.js` | 웜 전용 페이지 참조, `warmReady`/`warmLastError`, 직렬 락, `setupWarm`/`evaluateWarm` |
| `lib/navigationPolicy.js` | 페이지별 URL 접두 허용/차단, 복구, VM 재주입 옵션 |
| `lib/vmScript.js` | EverSafe 읽기, `fetchVmScript`, 가드 조합, `evalVmScriptInPage` |
| `lib/stealth.js` | UA·navigator 등 |

## 실행 모드 3종 (`executeOnPage`)
| 조합 | 모드 | 구현 |
|------|------|------|
| `vmLoadBaseUrl` 만 | VM 단독 | `readEverSafeVmScript` + `combineScriptWithOptionalGuard` + `evalVmScriptInPage` |
| `targetUrl` + `payload` | XHR 단독 | `buildXhrPostCode` + `page.evaluate` |
| 둘 다 | VM → XHR 순차 | VM 후 (선택) `postVmSettleMs` → XHR |

웜 **`/evaluate/warm`** 은 세 번째 조합 없이 **XHR 단독**만(같은 탭에는 이미 VM이 주입된 상태).

## 핵심 패턴
1. **싱글 브라우저 인스턴스**: 서버 시작 시 1회, 수명 동안 재사용
2. **세션 = 페이지**: sessionId ↔ Chromium 페이지, 쿠키 유지 (**웜 페이지는 세션 Map에 없음**)
3. **세션 타임아웃**: 10분 미사용 자동 정리, evaluate 시 갱신
4. **리소스 차단**: 이미지·폰트·미디어 abort
5. **메인 프레임 네비 정책**: `shouldAbortMainFrameNavigation` + (선택) 클라이언트 측 history/location 보조
6. **자동 복구**: 브라우저 disconnected 시 재실행·세션 전체 정리·**웜 재구성**
7. **Graceful Shutdown**: SIGINT/SIGTERM 시 웜 페이지·세션·브라우저 정리
8. **contentType 기본값**: `application/json` 하나; 폼·XML은 명시
9. **응답 파싱**: XHR 응답 Content-Type·본문 휴리스틱으로 JSON/텍스트
10. **관리 API 보호**: `BROWSER_ADMIN_TOKEN` 설정 시 `POST /browser/headful`, `POST /warm/retry`에 `X-Browser-Admin-Token`
