# 기본 YouTube 앱: TV 코드 경로

## 사용 조건

TV나 스트리밍 기기의 YouTube 앱에 숫자 **TV 코드로 연결 / 기기 추가** 기능이 있어야 합니다. 이 기능 자체는 [YouTube 도움말](https://support.google.com/youtube/answer/7640706)에 안내돼 있습니다. 서버에서 쓰는 Lounge HTTP 프로토콜은 Google의 공식 개발자 API가 아니며 사전 고지 없이 변경될 수 있습니다.

화면에 표시되는 로그인 활성화용 영숫자 코드와 혼동하지 마세요. 본인의 기기에서 직접 확인한 숫자 코드로만 연결합니다. 앱을 열거나 TV 전원을 켜는 기능은 이 경로가 보장하지 않습니다.

## 연결

```powershell
# 서버 종료 후 실행
node src/main.js pair-tv
# TV에 표시된 코드를 프롬프트에 입력
node src/main.js
```

설정 예제는 아래와 같습니다. 실제 값은 CLI가 로컬 파일에 저장합니다.

```json
{
  "type": "lounge",
  "experimental": true,
  "screenId": "YOUR_PAIRED_SCREEN_ID",
  "loungeToken": "YOUR_LOCAL_LOUNGE_TOKEN"
}
```

`screenId`, `loungeToken`, `remoteId`는 연결 정보입니다. 공개 저장소, 이슈, 화면 캡처에 넣지 마세요. 이 방식은 브라우저 로그인 상태, Google 계정 비밀번호, 브라우저 쿠키가 필요하지 않습니다. 설정 파일을 다른 사람에게 주면 TV 제어 권한도 노출될 수 있습니다.

## 자동 대기열 판정

1. `setPlaylist` HTTP 성공은 `sent_unconfirmed`입니다.
2. 전송 이후의 `nowPlaying` 이벤트에 요청한 `videoId`와 새로운 재생 nonce(`cpn`)가 있어야 합니다.
3. 그 nonce가 일치하는 `state=1`을 받아야 재생 중으로 확인합니다.
4. 같은 nonce의 `state=0`을 받아야 다음 곡으로 진행합니다. 실제 playing을 먼저 보지 못한 종료는 무시합니다.
5. 다른 영상, 이전 이벤트 번호(AID), 이전 nonce, 중복 종료 이벤트는 새 요청을 진행시키지 않습니다. 같은 노래를 두 번 신청해도 새 nonce가 필요합니다.
6. TV에서 다른 영상으로 바꾸거나 연결이 끊어지면 복구 대기로 둡니다. 다른 사용자의 재생을 자동으로 덮어쓰지 않습니다.

CPN이 없는 기기, 이벤트 형식이 다른 펌웨어, 계정/지역/연령 제한 콘텐츠에서는 자동 대기열이 동작하지 않을 수 있습니다. 이 경우 `다음`을 수동으로 사용하거나 브라우저/HDMI로 전환합니다. 광고의 길이로 종료를 추정하거나 광고를 제거하지 않습니다.

## 실패할 때

| 현상 | 확인 / 조치 |
|---|---|
| 코드 연결 실패 | 숫자 TV 연결 코드인지 확인하고 기기에서 새 코드를 생성 |
| `TV_NOT_PAIRED` | 연결이 해제됨. 본인 화면에서 새 코드로 다시 연결 |
| `TV_OFFLINE` / 45초 확인 시간 초과 | YouTube 앱이 열려 있는지와 기기의 인터넷 연결 확인 |
| 앱은 재생하지만 미확인 상태 | 영상 ID/CPN/이벤트를 받지 못한 것. 현장 확인 후 `확인` 또는 수동 `다음` |
| 연결이 중간에 끊김 | 이미 재생 중일 수 있으므로 실제 화면 확인 후 `재시도` 또는 `다음` |
| 다른 사용자가 TV 영상 변경 | 복구 대기. 해당 사용자의 재생을 확인한 뒤 운영자가 제어 재개 |
| 전체 Lounge 형식 변경 | 반복 연결 시도 중단, 브라우저/HDMI 경로로 전환 |

## 구현 근거와 검증 한계

공개된 [ytcast 프로토콜 설명](https://github.com/MarcoLucidi01/ytcast), [ytmogo Lounge 구현](https://github.com/jadilson12/ytmogo/tree/main/internal/lounge), [youtube-lounge-rs 이벤트 설명](https://github.com/bertybuttface/youtube-lounge-rs)을 참고해 Node 기본 모듈로 통신과 이벤트 검증을 구현했습니다. 런타임 외부 패키지에 의존하지 않습니다.

자동 테스트는 가짜 화면과 전송 규격을 검증합니다. 다른 프로젝트의 지원 사례를 이 프로젝트의 실기기 통과 기록으로 간주하지 않습니다. 현재 이 프로젝트의 실제 기기 검증은 0대입니다.
