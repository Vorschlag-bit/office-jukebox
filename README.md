# Office Jukebox

Google Chat 명령으로 유튜브 영상을 공유 화면에서 재생하는 개인용 오픈소스 MVP입니다. 노트북, 일반 모니터, 스마트 화면을 실험 대상으로 사용할 수 있습니다.

**Node.js 24 이상만 필요합니다. Python, npm 설치, 외부 Node 패키지가 필요하지 않습니다.**

> 구현 및 자동 테스트와 실기기 호환성 검증은 다릅니다. 현재 삼성·LG·Android TV의 실제 모델에서 검증하지 않았습니다. 기본 유튜브 앱의 영상 실행은 기기별 실험이 필요하고, 기본 앱 모드의 곡 넘김은 수동입니다. “모든 삼탠 모델 지원”을 주장하지 않습니다.

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

곡명 검색은 `youtubeApiKey`가 필요합니다. 검색 결과 중 첫 번째 영상을 신청하며, 선택 카드 UI는 이 버전에 없습니다. 원하는 버전을 확실히 재생하려면 URL을 사용하세요.

[Node.js 공식 사이트](https://nodejs.org/)에서 Node 24 이상을 설치하면 됩니다. npm 명령은 사용하지 않아도 됩니다.

## 구현된 기능

- Google Chat의 대화형 앱 → Pub/Sub pull 수신 → 노트북에서 실행. 공개 서버나 포트포워딩 불필요.
- 기존 Chat interaction 이벤트와 Workspace add-on의 `chat.messagePayload` 형식 처리.
- 채팅방 허용 목록, Google 사용자 ID 기반 운영자 권한, 오래된 요청 폐기.
- YouTube Data API 검색, 1시간/200개 검색 캐시, 직접 URL 신청.
- 디스크 대기열, 동시 요청 직렬화, 메시지 중복 처리 방지, 재시작 복구.
- Chat 응답용 영속 outbox와 결정적인 메시지 ID로 재전송 중복 방지.
- 브라우저/HDMI용 공식 YouTube IFrame 플레이어와 종료 이벤트 기반 다음 곡.
- Samsung Tizen 원격 WebSocket, LG webOS SSAP 직접 연결. **실험 기능, 기본 꺼짐.**
- Android TV/Google TV는 Home Assistant Android TV Remote REST 연동.
- 관리자와 재생기 토큰 분리, 한 재생기만 연결, 오래된 곡 이벤트 차단.
- UI, HTTP, WebSocket 프레이밍/실제 로컬 소켓, OAuth 서명, 대기열, 기기별 실패 사례 자동 테스트.

## 구조

```text
Google Chat 대화형 앱
  → Google Cloud Pub/Sub
  ← 로컬 노트북의 pull worker
     ├─ YouTube 검색
     ├─ JSON 디스크 대기열 / Chat 응답 outbox
     └─ 재생 어댑터
        ├─ browser → TV 브라우저 또는 노트북 HDMI → IFrame 플레이어
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
| `대기열`, `상태` | 현재 상태와 대기 곡 확인 | 허용 채팅방 사용자 |
| `다음` | 현재 곡 정지 명령 후 다음 곡 요청 | 운영자 |
| `정지` | 정지 명령 전송 및 대기열 전체 비움 | 운영자 |
| `재시도` | 오류/재시작 복구 상태의 곡을 다시 요청 | 운영자 |
| `확인` | 기본 앱에서 실제 재생을 현장에서 확인한 것으로 기록 | 운영자 |

접수 응답과 실제 재생은 구분합니다. 기본 앱은 `sent_unconfirmed`로 표시합니다. `확인`을 보내기 전까지 재생 중이라고 주장하지 않습니다. 현재 Google Chat에는 접수 응답과 사용자가 조회하는 상태를 제공하며, 재생 상태 변경마다 자동 알림을 보내지는 않습니다.

## 재생 방식 설정

실행을 중단하고 `config.local.json`의 `adapter`를 변경한 뒤 재시작합니다. 설정 변경은 현재 곡의 자동 재생을 유발하지 않습니다.

### 브라우저 또는 HDMI

```json
{ "type": "browser" }
```

TV 브라우저에서 노트북의 `/player`에 접속하려면 `host`를 `0.0.0.0`으로 바꾸고 `http://LOCAL_HOST:8787/player`를 엽니다. LOCAL_HOST는 직접 지정한 컴퓨터 주소입니다. 신뢰할 수 있는 로컬 네트워크에만 허용하세요. 기본 설정은 로컬에서만 접속됩니다. HTTP LAN 연결은 토큰과 요청을 암호화하지 않습니다. 필요한 경우 HTTPS 역방향 프록시를 사용하세요.

노트북에서 직접 재생 후 HDMI 출력하면 TV 브라우저 호환성 문제가 줄어듭니다. 구형 TV 브라우저는 ES5/XHR 기반 페이지라도 유튜브 자체 플레이어와 호환되지 않을 수 있습니다. 실제 사이트, 자동재생, 광고 후 복귀, 1시간 이상 연속재생을 시험해야 합니다.

재생 페이지는 음원을 추출하거나 광고를 차단하지 않고 공식 영상을 표시합니다. 탭을 숨기면 일시정지합니다. 영상 오류 발생 시 운영자가 `다음` 또는 `재시도`를 선택합니다.

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

**기본 앱 모드 3종에는 자동 곡 종료 감지가 없습니다.** 광고·버퍼링 때문에 영상 길이 타이머로 다음 곡을 넘기지 않습니다. 신뢰할 수 있는 기기별 재생 상태 연동을 추가하기 전까지 `다음`을 사용합니다. 어댑터를 바꿔도 검색과 대기열 코드는 그대로 사용합니다.

## Google Chat 연결

자세한 근거: [Google 공식 Pub/Sub Chat 앱 가이드](https://developers.google.com/workspace/chat/quickstart/pub-sub).

1. 개발용 Google Cloud 프로젝트를 만들고 Google Chat API, Pub/Sub API, YouTube Data API v3를 활성화합니다. 사용하는 Workspace에서 Chat 앱이 허용되어 있어야 합니다. Pub/Sub 사용에는 결제 계정 및 비용이 발생할 수 있습니다.
2. Pub/Sub topic과 **pull subscription**을 생성합니다. 구독의 dead-letter 정책은 운영 환경에 맞게 설정하세요.
3. Google Chat API → Configuration에서 앱 이름과 멘션/스페이스 참여 기능을 설정합니다. 연결 방식은 Cloud Pub/Sub, topic은 위에서 만든 것을 사용합니다. 앱 공개 대상은 테스트 사용자로 제한합니다.
4. Chat 설정 화면에 표시된 Chat 발행 주체에게 해당 topic의 Pub/Sub Publisher 권한을 줍니다. 이 주체와 노트북 worker 계정은 역할이 다릅니다.
5. 앱 프로젝트의 서비스 계정을 만들고 해당 subscription의 Pub/Sub Subscriber 권한을 줍니다. Chat 앱 인증에 사용할 계정으로 JSON 키를 발급하고 프로젝트 폴더의 `credentials.local.json`에 둡니다. 키 발급이 허용되지 않는 환경에서는 별도 인증 구성이 필요합니다.
6. 아래 설정을 `config.local.json`에 지정합니다. 계정 키, API 키, 토큰은 GitHub에 올리지 않습니다.

```json
{
  "enabled": true,
  "serviceAccountFile": "credentials.local.json",
  "subscription": "projects/YOUR_PROJECT/subscriptions/jukebox",
  "allowedSpaces": ["spaces/YOUR_SPACE"],
  "operatorUsers": ["users/YOUR_GOOGLE_CHAT_USER_ID"]
}
```

위 객체는 전체 설정의 `google` 필드 값입니다. 앱을 허용한 스페이스에 추가하고 멘션하여 요청합니다. Chat API 응답은 서비스 계정의 `chat.bot` 범위, Pub/Sub 수신은 `pubsub` 범위를 각각 사용합니다. 사용자 사칭이나 도메인 전체 위임은 하지 않습니다.

`spaces/...`, `users/...`는 Chat의 리소스 ID입니다. 이메일이나 화면 표시 이름이 아닙니다. Chat API/관리 콘솔 등 접근 권한이 있는 수단으로 확인하세요. 허용 목록이 비어 있으면 활성화되지 않습니다. Google 계정과 Workspace의 앱 사용 요건은 공식 가이드를 확인하세요.

## 테스트 / 진단

```powershell
node --test
node src/main.js doctor
node src/main.js probe
node src/main.js fingerprint
```

- `doctor`: 설정 검사. 실제 TV 호환성 판정이 아닙니다.
- `probe`: 설정된 삼성/LG 주소 하나에 TCP 연결이 되는지만 검사. 재생 명령은 전송하지 않습니다.
- `fingerprint`: 설정된 삼성/LG의 wss 주소에서 인증서 SHA-256 지문만 읽습니다. 출력값을 무조건 신뢰하지 마세요.
- 자동 테스트는 자격증명 없이 모의 Google·YouTube·TV 응답과 로컬 HTTP/WebSocket 서버로 실행합니다. 실제 유튜브 재생이나 특정 설치 환경은 테스트하지 않습니다.
- [테스트 결과와 범위](docs/TESTING.md), [월요일 실기기 검증표](docs/HARDWARE.md), [설계와 제한](docs/ARCHITECTURE.md)을 참고하세요.

## 실행 유지

실행 컴퓨터의 전원과 인터넷 연결을 유지하고, 자동 절전은 사용 환경에 맞게 설정합니다. 프로그램을 하나만 실행하세요. JSON 저장소는 여러 프로세스의 동시 쓰기를 지원하지 않습니다. 재시작 후 현재 곡은 `recovery_required`로 복구되어 운영자의 `재시도` 또는 `다음`을 기다립니다. 대기곡은 기본 4시간 후 만료됩니다.

Google 요청은 5분 이상 오래되면 폐기합니다. 서비스 중단 중 쌓인 명령이 출근 직후 갑자기 재생되는 것을 막기 위함입니다. 메시지 중복 기록은 최근 5,000개로 제한합니다.

## 참고 자료

- [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference)
- [YouTube 검색 API](https://developers.google.com/youtube/data/reference/rest/v3/search/list)
- [YouTube API 개발자 정책](https://developers.google.com/youtube/terms/developer-policies)
- [삼성 원격 제어 프로토콜 참고 프로젝트](https://github.com/xchwarze/samsung-tv-ws-api)
- [LG SSAP 참고 프로젝트](https://github.com/bendavid/aiopylgtv)
- [Home Assistant Android TV Remote](https://www.home-assistant.io/integrations/androidtv_remote/)

본 저장소는 위 프로젝트의 패키지에 의존하지 않습니다. 통신 형식을 참고해 작은 어댑터를 작성했습니다. 기기 제조사·Google·YouTube와 제휴한 프로젝트가 아닙니다.
