# 테스트 범위와 결과

2026-11-13, Windows / Node.js v24.22.1에서 `node --test` 실행.

108개 테스트가 모두 통과했습니다. 최신 결과는 GitHub Actions의 `tests` 집계와 아래 CI 링크를 확인하세요. 실제 Google 계정, API 키, 실제 TV는 사용하지 않았습니다.

로컬 샌드박스에서는 loopback 접속과 임시 파일 rename이 제한되어 실패했으며, 로컬 테스트 실행 권한으로 재실행하여 통과했습니다. 테스트를 건너뛰어 통과시킨 것은 아닙니다.

## 기기군별 시뮬레이션

| 프로필 / 조건 | 검증한 코드 동작 | 실제 모델 검증 |
|---|---|---|
| 삼성 Tizen, 원격 ws | 페어링 응답, 앱 ID, 링크 payload, 미확인 상태 | 미실시 |
| 삼성 Tizen, 원격 wss | 인증서 pin 필수, 토큰 재사용 | 미실시 |
| 삼성 연결 승인 거부/시간 초과 | 재생 명령을 보내지 않고 오류 | 미실시 |
| 삼성 실험 기능 꺼짐 | 영상 링크 전송 차단 | 미실시 |
| LG webOS ws | 등록, client key 재사용, SSAP 앱 launch, 미확인 상태 | 미실시 |
| LG 페어링 거부 | 오류 및 연결 정리 | 미실시 |
| LG 앱 없음/엔드포인트 거부 | 기기 오류 전파 | 미실시 |
| Android TV / Google TV + HA | REST 서비스와 activity URL | 미실시 |
| Android 잘못된 엔티티/없는 Remote Service | 오류 전파 | 미실시 |
| 브라우저/HDMI | 상태 이벤트와 자동 대기열, 오프라인/lease | 실제 유튜브 미실시 |
| 구형 Orsay / NetCast | 명시적 미지원 오류 | 미실시 |
| 일반 모니터 / 알 수 없는 OS / Android 태블릿 | 기본 앱 어댑터 미지원, browser+HDMI 안내 | 미실시 |

위 프로필은 모델명이 아닙니다. 실제 M5·M7·M8·스탠바이미 등의 구체적 연식과 모델별 통과를 주장하지 않습니다. 모의 응답이 펌웨어의 실제 응답과 같다는 보장은 없습니다.

## 추가 검증 영역

- 대기열 동시 요청, 중복, 최대 개수, 만료, 저장 복원, 손상 파일 보존.
- 브라우저 재생 상태, 오래된 종료 이벤트, 자동재생 차단, 영상 오류, 단일 재생기 lease, 재연결 복구.
- 실제 로컬 HTTP 연결에서 인증/권한/Origin/JSON/크기/경로 제한 및 전체 신청-재생 이벤트 흐름.
- 실제 로컬 WebSocket에서 upgrade 검증, 분할 JSON, ping/pong, 응답 시간 초과, 연결 종료.
- WebSocket 마스크, 16/64비트 길이, TCP 분할, 과도한 크기, 잘못된 제어 프레임.
- Google 이벤트 두 형식, bot 무시, space/user 검증, 오래된 요청, 응답 outbox/재전송, ACK 순서.
- RSA 서명 실제 검증, scope별 토큰 캐시와 만료 갱신.
- 유튜브 URL 호스트 검증, API 키 없는 URL 신청, 검색 필터/캐시, 할당량 오류 처리.
- 실제 CLI 프로세스 실행, 무작위 토큰 생성, 설정 덮어쓰기 방지, 설정 검증, 진단 출력, HTTP 서버 시작부터 신청곡 저장까지.

CI는 GitHub-hosted Windows/Linux + Node 24에서 같은 테스트를 실행합니다. CI 성공도 하드웨어 호환성 검증은 아닙니다.

[GitHub Actions](https://github.com/Vorschlag-bit/office-jukebox/actions)
