# Office Jukebox

Google Chat 명령으로 유튜브 영상을 공유 화면에서 재생하는 개인용 프로젝트입니다. 노트북, 일반 모니터, 스마트 화면을 사용할 수 있습니다.

**Node.js 24 이상만 필요합니다. Python, npm 설치, 외부 Node 패키지가 필요하지 않습니다.**

> **v0.3:** Apps Script 중계로 전환했습니다. 결제 미연결 프로젝트에서 사용하며 Pub/Sub 실행 경로는 차단합니다. 서비스 계정 키와 추가 OAuth 범위가 필요 없습니다. 실제 Google 배포·TV 호환성은 사용자 환경에서 확인해야 합니다.

**지금 Chat에 연결하는 순서: [Apps Script 상세 가이드](docs/APPS-SCRIPT.md).**

| 원하는 방식 | 선택 | 자동 다음 곡 |
|---|---|---|
| 기기의 기본 YouTube 앱 사용 | `lounge` — 본인 TV 코드로 연결, 비공식 프로토콜 선택 기능 | 영상 ID와 재생 nonce가 일치하는 시작·종료 이벤트를 받을 때 |
| 구형 기기/브라우저 호환성 우회 | `browser` — 노트북 Chrome 등에서 재생 후 HDMI 출력 | 공식 IFrame 이벤트를 받을 때 |
| 기기 내장 브라우저만 사용 | `browser` — 로컬 재생 페이지 접속 | 플레이어와 브라우저가 호환될 때 |
| 삼성/LG 직접 앱 실행, Android TV + HA | 기존 기기별 어댑터 | 수동 다음 곡 |

## 빠르게 실행

프로젝트 폴더에서:

```powershell
node src/main.js init
node src/main.js
```

1. `http://127.0.0.1:8787`에 접속합니다.
2. 생성된 `config.local.json`의 `adminToken`으로 관리 화면에 연결합니다.
3. 별도 탭에서 `http://127.0.0.1:8787/player`를 열고 `playerToken`으로 연결합니다.
4. 관리 화면에서 원하는 **HTTPS 유튜브 영상 URL**을 신청합니다. URL 신청은 API 키 없이 가능합니다.
5. 자동재생이 차단되면 재생 화면에서 **소리 있는 재생 허용**을 누릅니다.

곡명 검색은 `youtubeApiKey`가 필요합니다. `추가`는 첫 결과를 신청하고, `검색 <곡명>` → `선택 <번호>`로 원하는 결과를 고를 수 있습니다. 관리 화면에도 검색 후 선택 버튼이 있습니다.

기본 유튜브 앱을 사용하려면 아래 **TV 코드 연결**을 먼저 확인하세요. 빠른 실행은 별도 계정 설정 없이 로컬 URL 신청 흐름을 검증하는 경로입니다.

[Node.js 공식 사이트](https://nodejs.org/)에서 Node 24 이상을 설치하면 됩니다. npm 명령은 사용하지 않아도 됩니다.

## 구현된 기능

- Google Chat → Apps Script 대기열 ← 노트북의 서명된 HTTPS pull. 노트북 공개 서버·포트포워딩 불필요.
- 기존 Chat interaction 이벤트와 Workspace add-on의 `chat.messagePayload` 형식 처리.
- 채팅방 허용 목록, Google 사용자 ID 기반 운영자 권한, 오래된 요청 폐기.
- YouTube Data API 검색, 1시간/200개 검색 캐시, 직접 URL 신청.
- 디스크 대기열, 동시 요청 직렬화, 메시지 중복 처리 방지, 재시작 복구.
- 처리 결과 영속 outbox와 중계 결과 ID로 재수신 중복 억제. Chat의 `결과` 명령으로 조회.
- 결과 전달 장애와 명령 수신 분리, 지수 백오프, 잘못된 수신자 격리 및 관리자 재시도 API.
- 실제 재생 시작·기기 오류 알림, 검색 선택, 본인 신청 취소, 사용자별 대기곡 제한.
- 브라우저/HDMI용 공식 YouTube IFrame 플레이어와 종료 이벤트 기반 다음 곡.
- 곡별 플레이어 이벤트 격리, 상태 전송 재시도, 재생 확인 시간 초과 감지, 불가 영상 건너뛰기와 연속 오류 시 일시정지.
- TV 코드 기반 YouTube Lounge 어댑터와 재생 nonce 검증. **선택 기능, 실기기 미검증.**
- Samsung Tizen 원격 WebSocket, LG webOS SSAP 직접 연결. **실험 기능, 기본 꺼짐.**
- Android TV/Google TV는 Home Assistant Android TV Remote REST 연동.
- 관리자와 재생기 토큰 분리, 한 재생기만 연결, 오래된 곡 이벤트 차단.
- 동시 서버 잠금, fsync 후 파일 교체, 이전 상태 백업, 명시적인 복구 명령과 선택적인 프로세스 감독기.
- UI, HTTP, WebSocket 프레이밍/실제 로컬 소켓, OAuth 서명, 대기열, 기기별 실패 사례 자동 테스트.

## 구조

```text
Google Chat 대화형 앱
  → Apps Script (ScriptProperties 큐, OAuth 범위 없음)
  ← 로컬 노트북의 HMAC 서명 pull worker (기본 5초)
     ├─ YouTube 검색
     ├─ JSON 디스크 대기열 / Chat 응답 outbox
     └─ 재생 어댑터
        ├─ browser → TV 브라우저 또는 노트북 HDMI → IFrame 플레이어
        ├─ lounge → TV 코드로 연결한 기본 YouTube 앱 → 재생 상태 이벤트
        ├─ samsung → 기기 원격 WebSocket → 기본 YouTube 앱 (실험)
        ├─ lg → webOS SSAP → 기본 YouTube 앱 (실험)
        └─ android-ha → Home Assistant → Android TV Remote → 기본 YouTube 앱
```

GitHub는 소스 저장과 CI 테스트를 담당합니다. 기기 제어 프로그램은 대상 기기와 통신 가능한 로컬 컴퓨터에서 실행합니다. GitHub-hosted Actions를 24시간 음악 서버로 사용하지 않습니다.

## 명령

앱 멘션 후 아래 텍스트를 보냅니다. 현재 명령은 멘션 텍스트 방식이며 별도의 Google slash command 등록은 하지 않습니다.

| 명령 | 동작 | 권한 |
|---|---|---|
| `추가 <URL/곡명>` 또는 `재생 <URL/곡명>` | 대기열에 신청. 재생 중이면 끼어들지 않음 | 허용 채팅방 사용자 |
| `내정보`, `결과` | Chat의 현재 ID / 본인의 최신 처리 결과 확인 | 스페이스 참여자 / 허용 스페이스 사용자 |
| `대기열`, `상태` | 현재 상태와 대기 곡 확인 | 허용 채팅방 사용자 |
| `검색 <곡명>`, `선택 <번호>` | 후보 최대 5개 검색, 같은 사용자·채팅방에서 5분 안에 선택 | 허용 채팅방 사용자 |
| `취소 <대기번호>` | 자신의 대기곡 취소. 관리 UI는 고정 곡 ID를 사용 | 신청자 또는 운영자 |
| `일시정지`, `계속` | 현재 곡 및 다음 곡 자동 시작 보류/계속 | 운영자 |
| `다음` | 현재 곡 정지 명령 후 다음 곡 요청 | 운영자 |
| `정지` | 정지 명령 전송 및 대기열 전체 비움 | 운영자 |
| `재시도` | 오류/재시작 복구 상태의 곡을 다시 요청 | 운영자 |
| `확인` | 기본 앱에서 실제 재생을 현장에서 확인한 것으로 기록 | 운영자 |

접수 응답과 실제 재생은 구분합니다. 브라우저와 TV 코드 방식은 실제 이벤트를 받아 `playing`으로 전환하고 신청자의 최신 결과를 갱신합니다. Chat에서 `결과`로 조회합니다. 기존 기기별 앱 실행은 `sent_unconfirmed`이며 현장 확인이 필요합니다. 기본 45초 동안 확인이 없으면 오류로 표시합니다.

## 재생 방식 설정

실행을 중단하고 `config.local.json`의 `adapter`를 변경한 뒤 재시작합니다. 설정 변경은 현재 곡의 자동 재생을 유발하지 않습니다.

### 브라우저 또는 HDMI

```json
{ "type": "browser" }
```

TV 브라우저에서 노트북의 `/player`에 접속하려면 `host`를 `0.0.0.0`으로 바꾸고 `http://LOCAL_HOST:8787/player`를 엽니다. LOCAL_HOST는 직접 지정한 컴퓨터 주소입니다. 신뢰할 수 있는 로컬 네트워크에만 허용하세요. 기본 설정은 로컬에서만 접속됩니다. HTTP LAN 연결은 토큰과 요청을 암호화하지 않습니다. 필요한 경우 HTTPS 역방향 프록시를 사용하세요.

노트북에서 직접 재생 후 HDMI 출력하면 TV 브라우저 호환성 문제가 줄어듭니다. 구형 TV 브라우저는 ES5/XHR 기반 페이지라도 유튜브 자체 플레이어와 호환되지 않을 수 있습니다. 실제 사이트, 자동재생, 광고 후 복귀, 1시간 이상 연속재생을 시험해야 합니다.

재생 페이지는 공식 영상을 표시합니다. 탭을 숨기면 일시정지합니다. 삭제/임베드 제한 오류(100/101/150)는 기본적으로 다음 곡으로 넘어가며, 3곡 연속 실패하면 대기열을 일시정지합니다. 설정의 `autoSkipUnplayable: false`로 수동 처리할 수 있습니다. 네트워크·플레이어 환경 오류는 곡을 버리지 않고 운영자의 확인을 기다립니다.

### TV 코드 연결 — 기본 앱 사용을 위한 공통 경로

1. 본인 TV에서 YouTube 앱을 열고 설정의 **TV 코드로 연결 / 기기 추가**에서 숫자 코드를 확인합니다. 로그인 활성화 코드와 다릅니다.
2. 서버를 종료한 뒤 프로젝트 폴더에서 `node src/main.js pair-tv`를 실행하고 코드를 입력합니다.
3. `node src/main.js`로 서버를 시작합니다. YouTube 앱을 열어 둡니다.
4. URL을 신청한 뒤 `playing` 상태와 실제 화면·소리를 확인합니다. 2곡을 신청해 종료 후 다음 곡 전환도 확인합니다.

연결 정보는 Git에서 제외되는 로컬 설정에만 저장합니다. 브라우저 Google 로그인이나 쿠키를 읽지 않습니다. TV 코드로 연결할 수 있는 기기라도 이 비공식 프로토콜과 이벤트 형식이 호환된다는 보장은 없습니다. 앱이 재생 nonce를 보내지 않으면 자동 종료를 인정하지 않습니다. [TV 코드 방식의 한계와 검증 조건](docs/NATIVE-TV.md)을 반드시 확인하세요.

기본 앱 방식이 맞지 않으면 서버를 종료하고 `node src/main.js use-browser`로 전환합니다. `node src/main.js use-previous`로 이전 어댑터 설정을 되돌릴 수 있습니다. 이 전환은 기기 전원을 끄거나 재생을 원격으로 정지하지 않습니다. **화면에서 기존 재생을 먼저 멈춘 뒤** 다른 경로를 사용하세요.

### 삼성 Tizen 직접 연결 — 실험

```json
{
  "type": "samsung",
  "url": "ws://192.0.2.10:8001",
  "appId": "111299001912",
  "experimentalVideoLaunch": true
}
```

예제 IP는 문서용입니다. 실제 TV 주소로 바꾸세요. TV 연결 승인 창이 나오면 현장에서 허용합니다. 반환된 토큰은 로컬 설정에 저장됩니다. 앱 ID와 영상 링크 전달 형식은 기기/펌웨어에 따라 다릅니다. 앱 홈만 열리거나 링크가 무시될 수 있습니다.

8002 TLS만 지원하면 `wss://기기주소:8002`와 `fingerprint`에 TV 인증서의 SHA-256 지문을 설정하세요. 아래 `fingerprint` 명령은 인증서를 읽기만 합니다. 알려진 기기의 지문과 대조한 뒤 설정하세요. 전역 인증서 검증 해제는 하지 않습니다. 구형 Orsay 프로토콜은 구현하지 않았습니다.

### LG webOS 직접 연결 — 실험

```json
{
  "type": "lg",
  "url": "ws://192.0.2.11:3000",
  "appId": "youtube.leanback.v4",
  "experimentalVideoLaunch": true
}
```

기기에서 LG Connect Apps/모바일 연결 관련 기능을 허용해야 할 수 있습니다. 페어링 승인은 현장에서 합니다. 반환된 client key는 로컬 설정에 저장됩니다. 최소 권한 SSAP 등록과 `system.launcher/launch`의 `contentId` 방식을 시도합니다. 특정 모델의 페어링 manifest, 앱 ID, contentId가 맞지 않으면 실패합니다. 이 형식은 **실기기에서 미검증**이며 모든 webOS에서 지원한다고 보장하지 않습니다.

3001 TLS만 지원하면 `wss://기기주소:3001` 및 검증한 `fingerprint`를 사용하세요. 구형 NetCast는 구현하지 않았습니다.

### Android TV / Google TV

```json
{
  "type": "android-ha",
  "url": "http://192.0.2.12:8123",
  "token": "HOME_ASSISTANT_LONG_LIVED_TOKEN",
  "entityId": "remote.living_room_tv"
}
```

Home Assistant에 Android TV Remote 통합을 먼저 연결합니다. `remote.*` 엔티티를 사용하며 `remote.turn_on`의 `activity`로 유튜브 링크를 전달합니다. Home Assistant는 별도 서비스가 필요합니다. 본 프로젝트 자체에는 Python이 필요 없으며, 이 어댑터는 HA의 HTTP API만 호출합니다. HA를 쓰기 싫으면 브라우저/HDMI 모드를 사용하세요.

Android 태블릿에 이동식 거치대를 붙인 제품과 Android TV는 다릅니다. Android TV Remote Service가 없는 기기를 이 방식으로 지원한다고 가정하지 않습니다.

**삼성·LG 직접 실행 및 Android HA 어댑터에는 자동 곡 종료 감지가 없습니다.** `다음` 명령을 사용하거나 TV 코드 방식을 검증하세요. 어떤 어댑터도 곡 길이 타이머로 종료를 추정하지 않습니다.

## Google Chat 연결

[Apps Script 상세 가이드](docs/APPS-SCRIPT.md)의 순서대로 설정합니다. 결제 계정은 연결하지 않고 Google Chat API만 먼저 활성화합니다. 별도 서비스 계정 JSON 키가 필요하지 않습니다. 코드의 `apps-script/appsscript.json`은 배포 메타데이터이며 키 파일이 아닙니다.

Chat 앱 등록용 Head deployment ID와 노트북 연결용 웹 앱 /exec URL은 별개입니다. 일반 Chat 앱 모드로 등록하고 웹 앱은 소유자 실행·Anyone 접근이 필요합니다. 조직 정책에서 이 접근이 금지되면 해당 배포 경로를 사용할 수 없습니다. 코드로 정책을 우회하지 않습니다.

`@앱 내정보`로 ID 확인 → 양쪽 스페이스 허용 목록 설정 → `check-google` → 서버 실행 → `@앱 추가 <URL>` → 잠시 후 `@앱 결과` 순서로 TV 없이도 노트북에서 검증할 수 있습니다. `상태`·`검색` 등도 처리 후 `결과`로 조회합니다. 자발적 Chat 알림 푸시와 별도 웹훅은 사용하지 않습니다.

## 테스트 / 진단

```powershell
node --test
node src/main.js doctor
node src/main.js probe
node src/main.js fingerprint
node src/main.js check-google
```

- `doctor`: 설정 검사. 실제 TV 호환성 판정이 아닙니다.
- `probe`: 설정된 삼성/LG 주소 하나에 TCP 연결이 되는지만 검사. 재생 명령은 전송하지 않습니다.
- `fingerprint`: 설정된 삼성/LG의 wss 주소에서 인증서 SHA-256 지문만 읽습니다. 출력값을 무조건 신뢰하지 마세요.
- `check-google`: 서명된 중계 연결과 양쪽 허용 목록을 확인합니다. 곡 추가·메시지 발송은 하지 않으며 nonce 임시 캐시만 기록합니다. Cloud 결제 상태·Chat 등록·TV 재생을 검증하는 명령은 아닙니다.
- 자동 테스트는 자격증명 없이 모의 Google·YouTube·TV 응답과 로컬 HTTP/WebSocket 서버로 실행합니다. 실제 유튜브 재생이나 특정 설치 환경은 테스트하지 않습니다.
- [테스트 결과와 범위](docs/TESTING.md), [월요일 실기기 검증표](docs/HARDWARE.md), [설계와 제한](docs/ARCHITECTURE.md)을 참고하세요.
- [운영·복구 절차](docs/OPERATIONS.md), [최소 접근 범위](docs/ACCESS.md), [실사용 완료 조건](docs/ACCEPTANCE.md)도 참고하세요.

## 실행 유지

실행 컴퓨터의 전원과 인터넷 연결을 유지하고, 자동 절전은 사용 환경에 맞게 설정합니다. 프로그램을 하나만 실행하세요. JSON 저장소는 여러 프로세스의 동시 쓰기를 지원하지 않습니다. 재시작 후 현재 곡은 `recovery_required`로 복구되어 운영자의 `재시도` 또는 `다음`을 기다립니다. 대기곡은 기본 4시간 후 만료됩니다.

`node bin/run.js` 또는 Windows의 `run.cmd`는 비정상 종료 시 최대 30초 간격으로 서버를 복구합니다. 10분 내 5회 실패하면 중단합니다. OS 서비스나 예약 작업을 설치하지 않습니다. 저장소가 손상됐으면 서버를 종료하고 `node src/main.js restore-state`로 검증된 이전 백업을 복원할 수 있습니다. 손상 파일도 보존합니다.

Google 요청은 5분 이상 오래되면 폐기합니다. 서비스 중단 중 쌓인 명령이 출근 직후 갑자기 재생되는 것을 막기 위함입니다. 메시지 중복 기록은 최근 5,000개로 제한합니다.

## 참고 자료

- [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference)
- [YouTube 검색 API](https://developers.google.com/youtube/data/reference/rest/v3/search/list)
- [YouTube API 개발자 정책](https://developers.google.com/youtube/terms/developer-policies)
- [삼성 원격 제어 프로토콜 참고 프로젝트](https://github.com/xchwarze/samsung-tv-ws-api)
- [LG SSAP 참고 프로젝트](https://github.com/bendavid/aiopylgtv)
- [Home Assistant Android TV Remote](https://www.home-assistant.io/integrations/androidtv_remote/)

본 저장소는 위 프로젝트의 패키지에 의존하지 않습니다. 통신 형식을 참고해 작은 어댑터를 작성했습니다. 기기 제조사·Google·YouTube와 제휴한 프로젝트가 아닙니다.
