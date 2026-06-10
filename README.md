# 🚇 지하철 게임

수도권 지하철 노선도를 보고 **60초 안에 역 이름을 최대한 많이 맞추는** 웹 게임입니다.
순수 HTML/CSS/JavaScript로 만들어져 서버 없이 GitHub Pages에서 바로 돌아갑니다.

## 게임 방법

- **모드 선택**: 1~9호선 모드 / 전체 모드(GTX-A, 에버라인 등 수도권 전 노선) / 커스텀 모드(원하는 노선만 선택)
- 카메라가 줌인된 역의 이름을 입력창에 타이핑해서 맞춥니다. 추천 목록을 클릭하거나 방향키+Enter로 선택할 수 있습니다.
- **힌트 3개**: 힌트를 쓰면 해당 역 이름의 초성이 공개됩니다.
- 정답 여부와 관계없이 제출하면 노선도에 역 이름이 공개되고 다음 문제로 넘어갑니다.
- 남은 시간 10초부터 타이머가 빨간색으로 변합니다.

## 폴더 구성

```
subway-game/
├── index.html          ← 메인 페이지
├── css/style.css       ← 스타일/애니메이션
├── js/
│   ├── data.js         ← 노선·역 데이터 (공식 노선 색상, 2026년 기준)
│   ├── hangul.js       ← 초성/정답 판정 유틸
│   ├── layout.js       ← 노선도 좌표 계산
│   ├── map.js          ← SVG 노선도 렌더링 + 카메라 애니메이션
│   └── game.js         ← 게임 로직
└── assets/sounds/      ← correct.mp3 / wrong.mp3 넣는 곳
```

## 🔊 효과음 넣기

`assets/sounds/` 폴더에 아래 두 파일을 넣으면 됩니다 (이름 정확히 일치).

| 파일 | 재생 시점 |
|---|---|
| `correct.mp3` | 정답을 맞췄을 때 |
| `wrong.mp3` | 정답을 틀렸을 때 |

> mp3가 없어도 게임은 정상 작동하며 기본 효과음(비프음)으로 대체됩니다.

## 🌐 GitHub에 올리고 배포하기 (GitHub Pages)

### 방법 A — 웹 브라우저만으로 (git 몰라도 OK)

1. [github.com](https://github.com) 로그인 → 우측 상단 **+** → **New repository**
2. Repository name에 `subway-game` 입력 → **Public** 선택 → **Create repository**
3. 만들어진 저장소 페이지에서 **uploading an existing file** 링크 클릭
4. 이 폴더 안의 **모든 파일과 폴더**(index.html, css, js, assets)를 통째로 드래그해서 업로드
   - 폴더째 드래그하면 폴더 구조가 유지됩니다. (index.html이 저장소 **최상단**에 있어야 합니다!)
5. 아래 **Commit changes** 버튼 클릭
6. 저장소 상단 **Settings** → 왼쪽 메뉴 **Pages**
7. *Build and deployment* 의 **Source**를 `Deploy from a branch`로, **Branch**를 `main` / `/(root)`로 설정 → **Save**
8. 1~2분 뒤 같은 페이지 상단에 주소가 뜹니다:
   `https://내아이디.github.io/subway-game/`
   이 링크가 게임 주소입니다. 친구에게 공유하세요! 🎉

### 방법 B — git 명령어로

```bash
cd subway-game
git init
git add .
git commit -m "지하철 게임 첫 배포"
git branch -M main
git remote add origin https://github.com/내아이디/subway-game.git
git push -u origin main
```

그 다음 위 방법 A의 6~8단계(Settings → Pages 설정)만 동일하게 하면 됩니다.

### 파일을 수정했을 때

- 웹 방식: 저장소에서 파일 클릭 → 연필 아이콘으로 수정 → Commit. (또는 다시 드래그 업로드)
- git 방식: `git add . && git commit -m "수정" && git push`
- 푸시하면 1~2분 내에 자동으로 사이트에 반영됩니다.

## 💬 카카오톡 공유 버튼 활성화 (선택)

카카오톡 공유는 카카오 개발자 키가 필요합니다. 키가 없어도 나머지 공유(링크 복사, X, 기기 기본 공유)는 모두 동작합니다.

1. [developers.kakao.com](https://developers.kakao.com) → 로그인 → **내 애플리케이션** → **애플리케이션 추가하기**
2. 만든 앱 클릭 → **앱 키**에서 **JavaScript 키** 복사
3. 같은 화면의 **플랫폼 → Web** 에 배포 주소(`https://내아이디.github.io`) 등록
4. `index.html`을 열어 아래 부분을 찾아서:
   ```html
   <!-- Kakao.init("여기에_카카오_JavaScript_키"); -->
   ```
   주석을 풀고 키를 넣어주세요:
   ```html
   Kakao.init("복사한_JavaScript_키");
   ```

## 데이터 기준

- 2026년 운행 기준 수도권 전철 (한강버스 제외, 미개통 노선 제외)
- GTX-A는 현재 분리 운행 중인 운정중앙~서울역 / 수서~동탄 구간 반영
- 인천 1호선 검단 연장(검단호수공원·신검단중앙·아라) 포함
- 노선 색상은 각 운영기관 공식 색상 사용
