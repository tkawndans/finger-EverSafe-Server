# Project Brief

## 개요
Go 기반 외부 서버(Otto)에서 REST API로 호출하여 **실제 Chromium 브라우저 환경**에서 JavaScript를 실행하는 Node.js 중간 서버.

## 핵심 목표
1. 보안 모듈이 필요한 금융권 사이트(제주은행, 보험개발원 등)의 API를 **브라우저 세션 유지** 상태에서 자동 호출
2. 클라이언트에 **JS 소스 코드를 노출하지 않고** URL만으로 동작
3. JSON, form-urlencoded, XML 등 다양한 Content-Type의 payload를 유연하게 처리

## 핵심 요구사항
- 세션 기반 API: create → evaluate(VM/XHR/VM+XHR) → cookies → destroy
- Stateless 단발 실행 API: `/evaluate`
- 프리셋/수동 모드를 갖춘 브라우저 테스트 페이지
- `contentType` 필드 지원 (기본값 `application/json` 하나 유지)
- 보안: 임의 `code` 문자열 실행 차단, URL 기반 템플릿만 허용
