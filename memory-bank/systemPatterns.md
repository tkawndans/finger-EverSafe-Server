# System Patterns

## 아키텍처

### 세션 모드 (로그인 필요 시)
```
[Go Otto] → POST /session/create   → 페이지 생성, sessionId 반환
          → POST /session/evaluate  → 같은 페이지에서 실행 (쿠키/세션 유지)
          → POST /session/evaluate  → 로그인 상태 유지!
          → POST /session/destroy   → 페이지 닫기
```

### Stateless 모드 (단발성)
```
[Go Otto] → POST /evaluate → 새 페이지 → 실행 → 페이지 닫기
```

## 실행 모드 3종
| 조합 | 모드 | 생성 함수 |
|------|------|-----------|
| `vmLoadBaseUrl` 만 | VM 단독 | `buildVmLoadCode` |
| `targetUrl` + `payload` | XHR 단독 | `buildXhrPostCode` |
| `vmLoadBaseUrl` + `targetUrl` + `payload` | VM → XHR 순차 | `buildVmLoadThenXhrPostCode` |

## 핵심 패턴
1. **싱글 브라우저 인스턴스**: 서버 시작 시 1회 실행, 전체 수명 동안 재사용
2. **세션 관리**: sessionId로 페이지를 유지하여 쿠키/로그인 상태 보존
3. **세션 타임아웃**: 10분 미사용 시 자동 정리, evaluate 시 갱신
4. **리소스 차단**: request interception으로 이미지/폰트/미디어 차단
5. **자동 복구**: 브라우저 disconnected 시 자동 재실행, 세션 전체 정리
6. **Graceful Shutdown**: SIGINT/SIGTERM 시 전체 정리 후 종료
7. **코드 미노출**: 클라이언트는 URL만 전달 → JS 소스가 패킷에 포함되지 않음
8. **contentType 기본값**: `application/json` 단 하나 유지, 폼·XML은 명시적 지정
9. **XHR 본문 직렬화**: 문자열 payload는 그대로 전송, JSON contentType일 때만 객체 직렬화
10. **응답 파싱**: 응답의 Content-Type 헤더 기준으로 JSON/텍스트 구분
