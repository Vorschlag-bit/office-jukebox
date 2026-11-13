import { check, jsonFetch } from './util.js';

// Read-only provider checks. Does not consume Pub/Sub messages or post to a Chat space.
export async function verifyGoogle(config, auth, fetcher = fetch) {
  check(/^projects\/[A-Za-z0-9_-]+\/subscriptions\/[A-Za-z0-9_.~-]+$/.test(config.subscription || ''), 'CONFIG', 'Pub/Sub 구독 이름을 확인하세요.');
  const results = [];
  const probes = [
    { name: 'pubsub-subscription', scope: 'https://www.googleapis.com/auth/pubsub', url: `https://pubsub.googleapis.com/v1/${config.subscription}` },
    ...(config.allowedSpaces || []).map(space => {
      check(/^spaces\/[A-Za-z0-9_-]+$/.test(space), 'CONFIG', '허용 채팅방 ID를 확인하세요.');
      return { name: 'chat-space', scope: 'https://www.googleapis.com/auth/chat.bot', url: `https://chat.googleapis.com/v1/${space}` };
    })
  ];
  for (const probe of probes) {
    try {
      const token = await auth.token(probe.scope);
      await jsonFetch(probe.url, { headers: { Authorization: `Bearer ${token}` } }, fetcher);
      results.push({ check: probe.name, ok: true });
    } catch (error) { results.push({ check: probe.name, ok: false, error: error.code || 'AUTH', upstreamStatus: error.upstreamStatus }); }
  }
  return { ok: results.every(x => x.ok), checks: results, messagePosted: false, playbackVerified: false };
}
