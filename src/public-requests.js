import { createHmac, randomBytes } from 'node:crypto';
import { check, equalSecret, videoId } from './util.js';
import { validLocalHostname } from './security.js';
import { playlistId } from './youtube.js';

export function publicQueueUrl(config) {
  const host=config.lan?.enabled && config.lan.hostnames?.[0];
  return validLocalHostname(host) ? `http://${host.toLowerCase()}:${config.port}/queue` : null;
}
export function createPublicRequests({engine,config,now=Date.now}) {
  const enabled=()=>config.lan?.enabled===true && config.lan.requests?.enabled===true;
  const sessions=new Map(),limits=new Map();let globalSearch={since:now(),count:0};
  const sign=value=>createHmac('sha256',config.lan.requests.secret).update(value).digest('base64url');
  const limit=(key,max,window)=>{const time=now();let bucket=limits.get(key);if(!bucket||time-bucket.since>=window)bucket={since:time,count:0};check(bucket.count<max,'REQUEST_LIMIT','신청 또는 검색이 잠시 많아요. 조금 뒤 다시 시도해 주세요.',429);bucket.count++;limits.set(key,bucket);if(limits.size>2000)limits.delete(limits.keys().next().value);};
  function cookieIdentity(req){const value=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('jukebox-requester='))?.slice(18);const parts=value?.split('.')||[];return parts.length===2&&/^[a-f0-9]{32}$/.test(parts[0])&&equalSecret(parts[1],sign(parts[0]))?parts[0]:null;}
  function available(){check(enabled(),'NOT_FOUND','웹 신청이 꺼져 있습니다.',404);}
  function session(req,res){
    available();check(!req.headers['sec-fetch-site']||['same-origin','none'].includes(req.headers['sec-fetch-site']),'ORIGIN','음악방 페이지에서 신청창을 열어 주세요.',403);
    for(const[id,s]of sessions)if(s.expires<=now())sessions.delete(id);
    let id=cookieIdentity(req)||randomBytes(16).toString('hex'),s=sessions.get(id);
    if(!s){check(sessions.size<500,'REQUEST_BUSY','신청창이 많아요. 잠시 후 다시 열어 주세요.',503);s={csrf:randomBytes(24).toString('base64url'),expires:now()+12*3600000};sessions.set(id,s);}
    res.setHeader('Set-Cookie',`jukebox-requester=${id}.${sign(id)}; Path=/api/public; HttpOnly; SameSite=Strict; Max-Age=43200${req.socket.encrypted?'; Secure':''}`);
    return {csrfToken:s.csrf,searchEnabled:!!engine.youtube.key,perUserLimit:engine.perUserLimit};
  }
  async function request(req,body){
    available();check(req.headers.origin===`${req.socket.encrypted?'https':'http'}://${req.headers.host}`,'ORIGIN','다른 사이트에서 신청할 수 없습니다.',403);
    const id=cookieIdentity(req),session=id&&sessions.get(id);check(session&&session.expires>now()&&equalSecret(req.headers['x-jukebox-csrf'],session.csrf),'REQUEST_SESSION','신청창 연결이 만료됐어요. 다시 연결한 뒤 시도해 주세요.',401);
    check(body&&['search','add','playlist','select'].includes(body.action),'REQUEST_ACTION','검색·링크 신청·목록 신청·후보 선택만 사용할 수 있습니다.');
    check(typeof body.requestId==='string'&&/^[a-f0-9]{32}$/.test(body.requestId),'REQUEST_ID','신청 식별자를 확인해 주세요.');
    const user='web-'+sign(id),eventId=user+'-'+body.requestId;
    // A completed retry is answered before quotas or candidate state are touched.
    const previous=engine.state.seen[eventId];if(previous?.publicResult)return structuredClone(previous.publicResult);
    const ip=req.socket.remoteAddress||'unknown';limit('post:'+ip,8,60000);
    let text;
    if(body.action==='select'){
      check(Number.isInteger(body.index)&&body.index>=1&&body.index<=5&&typeof body.selectionId==='string'&&/^[a-f0-9-]{36}$/.test(body.selectionId),'CHOICE','검색 결과에서 노래를 골라 주세요.');text='선택 '+body.index;
    }else{
      check(typeof body.query==='string'&&body.query.trim().length>0&&body.query.length<=300&&!/[\r\n]/.test(body.query),'QUERY','링크 또는 곡명을 1~300자로 입력해 주세요.');const query=body.query.trim();
      if(body.action==='search'){
        check(engine.youtube.key,'YOUTUBE_KEY','곡명 검색이 아직 연결되지 않았어요. YouTube 링크로 신청해 주세요.');
        check(!/^https?:\/\//i.test(query),'QUERY','검색할 가수와 곡명을 입력해 주세요. 링크는 링크 신청을 이용해 주세요.');
        limit('search:'+ip,12,3600000);if(now()-globalSearch.since>=3600000)globalSearch={since:now(),count:0};check(globalSearch.count<30,'SEARCH_LIMIT','웹 검색 요청이 많아요. 잠시 링크 신청을 이용해 주세요.',429);globalSearch.count++;text='검색 '+query;
      }else{let parsed;try{parsed=new URL(query);}catch{}check(parsed&&!parsed.username&&!parsed.password&&!parsed.port,'URL','올바른 HTTPS YouTube 링크를 입력해 주세요.');check(/^https:\/\//i.test(query) && (body.action==='playlist'?!!playlistId(query):!!videoId(query)),'URL','올바른 HTTPS YouTube 영상 또는 재생목록 링크를 입력해 주세요.');text=(body.action==='playlist'?'목록 ':'추가 ')+query;}
    }
    return engine.command({text,user,eventId,selectionId:body.action==='select'?body.selectionId:undefined,includeChoices:true});
  }
  return {enabled,session,request};
}
