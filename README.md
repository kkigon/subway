# 🚇 지하철 게임

수도권 지하철 노선도를 보고 **60초 안에 역 이름을 최대한 많이 맞추는** 웹 게임입니다.

## 게임 방법

- **모드 선택**: 1~9호선 모드 / 전체 모드(GTX-A, 에버라인 등 수도권 전 노선) / 커스텀 모드(원하는 노선만 선택)
- 카메라가 줌인된 역의 이름을 입력창에 타이핑해서 맞춥니다. 추천 목록을 클릭하거나 방향키+Enter로 선택할 수 있습니다.
- **힌트 3개**: 힌트를 쓰면 해당 역 이름의 초성이 공개됩니다.
- 정답 여부와 관계없이 제출하면 노선도에 역 이름이 공개되고 다음 문제로 넘어갑니다.
- 남은 시간 10초부터 타이머가 빨간색으로 변합니다.


## 데이터 기준

- 2026년 운행 기준 수도권 전철 (한강버스 제외, 미개통 노선 제외)
- GTX-A는 현재 분리 운행 중인 운정중앙-서울역 / 수서-동탄 구간 반영
- 인천 1호선 검단 연장(검단호수공원·신검단중앙·아라) 포함
- 노선 색상은 각 운영기관 공식 색상 사용

## 대전 모드 서버 설정

대전 모드는 Supabase Realtime과 Postgres RPC를 사용합니다.

1. `js/supabase-config.js`에 Supabase의 현재 **Publishable key**를 설정합니다.
2. 새 DB라면 `supabase/versus-step1-rooms.sql`을 먼저 실행합니다.
3. `supabase/versus-multiplayer-authority.sql`을 Supabase SQL Editor에서 실행합니다.
4. Supabase Realtime에서 Presence/Broadcast 사용이 허용되어 있는지 확인합니다. `rooms`와 기존 `game_states` 테이블의 Postgres Changes publication 등록은 3번 SQL이 처리합니다.

참가자 온라인 상태는 Presence가 단일 진실이며, 방장·설정·게임 상태처럼 지속되어야 하는 값은 Postgres가 단일 진실입니다. 방장 변경은 클라이언트의 직접 테이블 수정이 아니라 원자적 RPC를 통해서만 이루어집니다.
