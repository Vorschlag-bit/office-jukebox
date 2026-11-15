/* ES5 shared character copy; mirrored in Apps Script's standalone Code.gs. */
var UsagiVoice = (function () {
// Fan-style interpretation: keep actionable status/error details after the character line.
function jbTone(kind, seed) {
  var lines = {
    connected: ['후웅~ 음악방이랑 통했어! 연결 상태는 아래!', '푸루! 우사기랑 연결 확인. 이제 같이 들어볼까?', '이~! 연결 소식 도착! 아래 상태를 봐 줘.'],
    received: ['푸루! 접수는 우사기한테 맡겨! ♪', '후웅~ 신청 받았어. 우사기가 살펴볼게!', '푸루야! 노래 배달 출발 준비~!'],
    playing: ['우라라라~!! 지금 이 곡이다! ♪', '야하~야핫! 음악 나오는 중! 신난다!', '푸루루루~♪ 우사기 음악방, 흔들흔들!'],
    added: ['우~라~! 플레이리스트가 통통해졌어!', '푸루야! 신청곡 줄 세우기, 우사기에게 맡겨!', '야핫! 이 곡도 챙겼다! ♪'],
    paused: ['후운~ 잠깐 쉬어가는 거구나. 우사기도 쪼그려 앉기!', '푸루. 일시정지 요청 받았어. 잠깐 숨 고르자!', '쥬르리… 쉬는 동안 간식 생각 중. 일시정지 요청!'],
    resumed: ['우라우라! 다시 달릴 준비~! 재생 계속 요청!', '푸루야! 쉬는 시간 끝. 재생 계속 요청했어!', '야하~야핫! 다시 듣자! 계속 재생 요청!'],
    next: ['우라우라! 다음 곡 쪽으로, 따라와~!', '푸루야! 다음 곡으로 폴짝!', '이~! 다음 곡도 여기 있다!'],
    stopped: ['하! 오늘 음악은 여기까지. 우사기도 쉬러 간다!', '후운~ 재생은 멈추고, 대기열도 싹 정리!', '푸루. 정리했어! 다음 음악회 때 또 만나!'],
    confirm: ['후웅? 재생을 멈추고 대기열까지 모두 비울까?', '하아? 전부 비우는 거야? 아래 확인 버튼을 눌러 줘!', '푸루? 정지는 확인 한 번만! 대기열도 같이 비워져.'],
    cancel: ['푸루. 신청 취소 확인! 이 곡은 줄에서 쏙!', '이~! 취소한 곡은 우사기가 챙겨 뺐어.', '후운~ 이 곡은 다음 기회에!'],
    error: ['하아?! 우사기도 깜짝! 아래 이유를 확인해 줘.', '후와~앙… 잠깐 막혔어. 아래 안내대로 다시 해보자!', '호와?! 이 요청은 지금 처리하기 어려워. 이유는 아래!'],
    menu: ['이~! 우사기 음악방 여기 봐! 링크를 넣고 골라 줘 ♡', '푸루야! 같이 듣자! 노래 신청은 아래 버튼으로!', '후웅~ 오늘은 뭘 들을까? 우사기한테 링크를 줘!'],
    empty: ['쥬르리… 노래도 간식처럼 기다리는 중! 첫 신청곡 어디 있지?', '후웅? 아직 조용하네. 좋아하는 노래를 데려와 줘!', '푸루야! 빈 음악방을 같이 채워보자!'],
    result: ['이~! 우사기가 확인한 결과, 여기 있어!', '후운~ 어떻게 됐는지 같이 볼까?', '푸루! 확인한 내용은 아래에 적어뒀어.']
  };
  var choices = lines[kind] || lines.result, hash = 0, text = String(seed || kind);
  for (var i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return choices[hash % choices.length];
}
function jbSpeakResponse(response, seed) {
  if (!response || typeof response.text !== 'string' || /^(야하|야핫|우라|우~라|하아|하!|푸루|후웅|후운|후와|호와|쥬르리|이~)/.test(response.text)) return response;
  var text = response.text, kind = 'result';
  if (/링크를 붙여|버튼으로 신청|현재 음악방/.test(text)) kind = 'menu';
  if (/아직 처리 결과가 없|신청곡을 기다|현재: 없음.*대기: 없음/.test(text)) kind = 'empty';
  if (/^연결됨|^연결이 복구/.test(text)) kind = 'connected';
  if (/접수했습니다|이미 접수|재생 요청됨/.test(text)) kind = 'received';
  if (/대기열에 담/.test(text)) kind = 'added';
  if (/^재생 중(?:$|:)/.test(text)) kind = 'playing';
  if (/일시정지를 요청|일시정지됨|대기열이 일시정지/.test(text)) kind = 'paused';
  if (/재생 계속을 요청/.test(text)) kind = 'resumed';
  if (/다음 곡으로 이동/.test(text)) kind = 'next';
  if (/신청 취소:/.test(text)) kind = 'cancel';
  if (/재생을 멈추고 대기열을 비웠|대기열 비움 완료/.test(text)) kind = 'stopped';
  if (/비울까요/.test(text)) kind = 'confirm';
  if (/지원하지|허용되지|못했|오류|만료|차단|거부|설정이 필요|필요합니다|연결을 확인|유효한 HTTPS|입력하세요|입력해 주세요|올바르지|실패|운영자만|본인의 신청곡만|가득|개까지 신청/.test(text)) kind = 'error';
  // Receipts stay receipts; do not imply playback until the player has reported it.
  text = text.replace('접수했습니다. 보통 5~10초 안에 처리해요. 아래 결과 확인 버튼으로 진행 상황을 볼 수 있어요.', '신청 접수! 보통 5~10초 뒤 처리돼. 아직 재생 확인은 아니야. 아래에서 내 신청 결과 확인을 눌러 줘!')
    .replace('링크를 붙여 넣고 신청 버튼을 누르세요. 재생 제어와 결과 조회도 버튼으로 할 수 있어요.', '영상 링크는 신청하기, 재생목록 링크는 목록 담기! 재생 제어와 결과 확인도 아래 버튼으로 골라 줘.')
    .replace('버튼으로 신청하고 제어할 수 있어요. 아래에서 원하는 동작을 골라 주세요.', '우사기 호출 완료! 신청하기·목록 담기·재생 제어, 원하는 버튼을 콕 눌러 줘!');
  response.text = jbTone(kind, String(seed || '') + text) + '\n' + text;
  return response;
}

return { say: function (text, seed) { return jbSpeakResponse({ text: String(text) }, seed).text; }, tone: jbTone };
})();
