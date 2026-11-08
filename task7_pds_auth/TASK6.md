# T06 Plan-Do-See 다이어리

계획(Plan) → 실행(Do) → 회고(See)를 서버 DB(Supabase PostgreSQL)에 저장하고 연결하는 정적 웹앱입니다. 로그인은 없습니다(T07에서 접근 제어 적용).

## 구성
- `index.html`, `app.js`, `styles.css`: 화면. 빌드 없음. 사용자 문자열은 모두 textContent로 그립니다.
- `config.js`: Supabase 프로젝트 URL과 publishable key(공개 키)만 둡니다.
- `db/001_pds_schema.sql`: 테이블·제약·RLS·RPC 함수. `db/002_verify.sql`: 적용 후 읽기 전용 점검.
- `contracts/pds-schema-v2.json`: 최종 테이블·컬럼·관계·날짜/시간 규칙.
- `vercel.json`: CSP 등 보안 헤더. `tests/`: PGlite(PostgreSQL WASM) DB 테스트와 Chrome E2E 테스트.

## 핵심 동작
1) 계획: 기간·우선순위·성공 기준·예상 시간(분). 수정 시 ID 유지, 버전별 스냅샷을 `pds_plan_revisions`에 추가(최초 계획 v1 보존, 이력 UPDATE는 트리거가 거부).
2) 할 일: 생성·수정·완료·완료 취소·삭제(삭제 표시), 마감일·우선순위·태그·예상 시간, 검색·필터·정렬(기준과 보조 기준을 화면에 표시).
3) 완료 중복 방지: 멱등성 키 UNIQUE + 할 일당 유효 완료 1건 부분 유니크 인덱스 + 행 잠금. 버튼 비활성화에 의존하지 않습니다.
4) 실행 기록: 시작·종료(서울 시각 입력, UTC 저장)·실제 분·막힘 사유. 계획·할 일 예상 값은 바뀌지 않습니다.
5) 회고: 계획 수·완료 수·지연 수(서울 오늘 기준, 완료 제외)·막힘 수·예상/실제/차이(분). 값을 누르면 근거 기록만 걸러 보여 줍니다. 개선점으로 다음 계획을 만들면 `source_review_id`와 개선점 원문이 다음 계획에 저장됩니다.
6) 내보내기: `pds_snapshot()` 전체를 JSON 파일 하나로 내려받습니다.

## 테스트
```
cd task6_pds_diary/tests
npm ci
npm run test:db    # 스키마 SQL을 PGlite에 적용, anon 역할 RPC로 기준별 검증
npm run test:e2e   # 로컬 서버(PGlite) + 설치된 Chrome으로 화면 조작 검증
```
