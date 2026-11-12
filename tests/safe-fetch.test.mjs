import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createSafeFetcher,resolvePublicAddresses} from '../server/safe-fetch.mjs';

const addresses = (...ips) => ips.map(address => ({address,family:4}));

test('reserved proxy DNS tokens are replaced by public DNS answers, never allowlisted', async () => {
  let queries=0;
  const resolved=await resolvePublicAddresses('public.example',{lookupAddress:async()=>addresses('198.18.0.12','198.19.255.20'),queryPublicDNS:async hostname=>{queries++;assert.equal(hostname,'public.example');return addresses('93.184.216.34')}});
  assert.deepEqual(resolved,addresses('93.184.216.34'));assert.equal(queries,1);
  for(const input of [addresses('127.0.0.1'),addresses('10.0.0.1'),addresses('198.18.0.12','127.0.0.1'),addresses('198.18.0.12','93.184.216.34')]) {
    await assert.rejects(resolvePublicAddresses('public.example',{lookupAddress:async()=>input,queryPublicDNS:()=>{throw new Error('No fallback for private or mixed DNS')}}),{code:'UNSAFE_URL'});
  }
  for(const reply of [[],addresses('198.18.0.22'),addresses('192.168.0.1'),addresses('93.184.216.34','10.0.0.1'),[{address:'93.184.216.34',family:6}]]) {
    await assert.rejects(resolvePublicAddresses('public.example',{lookupAddress:async()=>addresses('198.18.0.12'),queryPublicDNS:async()=>reply}),{code:'UNSAFE_URL'});
  }
});

function transport(replies,connections) {
 return {get(url,options,callback){
  const request=new EventEmitter();
  request.destroy=error=>{if(error)request.emit('error',error);request.emit('close');};
  queueMicrotask(()=>{
    const reply=replies.shift();
    const observed=[];
    options.lookup(url.hostname,{all:true},(error,value)=>{assert.ifError(error);observed.push(...value)});
    options.lookup(url.hostname,{},(error,address,family)=>{assert.ifError(error);assert.deepEqual({address,family},observed[0])});
    connections.push({host:url.hostname,observed,headers:options.headers});
    reply.onRequest?.();
    if (reply.error) { request.destroy(reply.error); return; }
    const response=new PassThrough();
    response.statusCode=reply.status||200;response.headers=reply.headers||{'content-type':'text/html'};
    response.on('end',()=>request.emit('close'));response.on('close',()=>request.emit('close'));
    callback(response);response.end(reply.body||'');
  });
  return request;
 }};
}

test('every redirect repeats resolution and pins its validated public address without a second system lookup', async () => {
 const lookups=[],queries=[],connections=[];
 const client=transport([{status:302,headers:{location:'https://second.example/page'}},{body:'<main>第二个页面的可验证正文。</main>'}],connections);
 const read=createSafeFetcher({
  lookupAddress:async hostname=>{lookups.push(hostname);return addresses('198.18.0.8')},
  queryPublicDNS:async hostname=>{queries.push(hostname);return addresses(hostname==='first.example'?'93.184.216.34':'1.1.1.1')},httpsClient:client,
 });
 const result=await read('https://first.example/page');
 assert.equal(result.url,'https://second.example/page');assert.match(result.text,/第二个页面/);
 assert.deepEqual(lookups,['first.example','second.example']);assert.deepEqual(queries,lookups);
 assert.deepEqual(connections.map(item=>item.observed),[addresses('93.184.216.34'),addresses('1.1.1.1')]);
 assert.equal(connections.some(item=>'Cookie' in item.headers||'Authorization' in item.headers),false);
});

test('a public first hop cannot redirect through a private DNS answer or literal private URL', async () => {
 for(const destination of ['https://private.example/page','http://127.0.0.1/private']) {
  const connections=[];const client=transport([{status:302,headers:{location:destination}}],connections);
  const read=createSafeFetcher({lookupAddress:async host=>addresses(host==='private.example'?'10.0.0.1':'93.184.216.34'),queryPublicDNS:()=>{throw new Error('No private fallback')},httpsClient:client});
  await assert.rejects(read('https://first.example/page'),{code:'UNSAFE_URL'});assert.equal(connections.length,1);
 }
});

test('cover reads send only public HTTPS raster requests and do not accept SVG', async () => {
 const connections=[];
 const read=createSafeFetcher({lookupAddress:async()=>addresses('93.184.216.34'),httpsClient:transport([
  {status:302,headers:{location:'http://images.example/insecure.png'}},
  {headers:{'content-type':'image/svg+xml'},body:'<svg></svg>'},
  {headers:{'content-type':'image/png'},body:Buffer.from([0x89,0x50,0x4e,0x47])},
 ],connections)});
 const options={representation:'cover'};
 await assert.rejects(read('https://images.example/redirect',0,options),{code:'UNSAFE_URL'});
 await assert.rejects(read('https://images.example/vector.svg',0,options),{code:'FETCH_FAILED'});
 assert.deepEqual((await read('https://images.example/cover.png',0,options)).bytes,Buffer.from([0x89,0x50,0x4e,0x47]));
 assert.equal(connections.length,3);
 assert.ok(connections.every(connection=>Object.keys(connection.headers).every(name=>!['referer','cookie','authorization'].includes(name.toLowerCase()))));
});

test('caption reads allow only HTTPS YouTube timed text for the same video across redirects', async () => {
 const endpoint='https://www.youtube.com/api/timedtext?v=video123456&fmt=json3';
 for (const destination of ['https://other.example/api/timedtext?v=video123456',
  'https://www.youtube.com/watch?v=video123456','https://www.youtube.com/api/timedtext?v=video654321',
  'http://www.youtube.com/api/timedtext?v=video123456','https://www.youtube.com/api/timedtext?v=video123456&v=video123456']) {
  const connections=[];
  const read=createSafeFetcher({lookupAddress:async()=>addresses('93.184.216.34'),
   httpsClient:transport([{status:302,headers:{location:destination}}],connections)});
  await assert.rejects(read(endpoint,0,{representation:'youtube-captions'}),{code:'UNSAFE_URL'});
  assert.equal(connections.length,1);
 }
 const connections=[];
 const read=createSafeFetcher({lookupAddress:async()=>addresses('93.184.216.34'),
  httpsClient:transport([{headers:{'content-type':'application/json'},body:'{"events":[]}'}],connections)});
 assert.equal((await read(endpoint,0,{representation:'youtube-captions'})).text,'{"events":[]}');
});

const networkError = code => Object.assign(new Error('simulated connection failure'), {code});

test('a reset retries once, repeats public DNS validation and pins the newly validated address', async () => {
 const connections=[],lookups=[],queries=[];
 const client=transport([{error:networkError('ECONNRESET')},{body:'<main>连接恢复后的真实正文。</main>'}],connections);
 const read=createSafeFetcher({
  lookupAddress:async host=>{lookups.push(host);return addresses('198.18.0.8')},
  queryPublicDNS:async host=>{queries.push(host);return addresses(queries.length===1?'93.184.216.34':'1.1.1.1')},
  httpsClient:client,
 });
 const result=await read('https://retry.example/article');
 assert.match(result.text,/连接恢复后的真实正文/);
 assert.deepEqual(lookups,['retry.example','retry.example']);
 assert.deepEqual(queries,lookups);
 assert.deepEqual(connections.map(item=>item.observed),[addresses('93.184.216.34'),addresses('1.1.1.1')]);
});

test('transient DNS lookup failures and connection timeouts have the same single-retry bound', async () => {
 for(const code of ['EAI_AGAIN','ETIMEDOUT']) {
  let lookups=0;const connections=[];
  const reply=code==='EAI_AGAIN'?[{body:'恢复后的正文。'}]:[{error:networkError(code)},{body:'恢复后的正文。'}];
  const read=createSafeFetcher({lookupAddress:async()=>{lookups++;if(code==='EAI_AGAIN'&&lookups===1)throw networkError(code);return addresses('93.184.216.34')},httpsClient:transport(reply,connections)});
  assert.match((await read('https://retry.example/article')).text,/恢复后的正文/);
  assert.equal(lookups,2,code);
  assert.equal(connections.length,code==='EAI_AGAIN'?1:2,code);
 }
});

test('repeated connection resets stop after two attempts and retry budgets do not reset in a redirect cycle', async () => {
 let lookups=0;const connections=[];
 const read=createSafeFetcher({lookupAddress:async()=>{lookups++;return addresses('93.184.216.34')},httpsClient:transport([{error:networkError('ECONNRESET')},{error:networkError('ECONNRESET')},{body:'must not read'}],connections)});
 await assert.rejects(read('https://retry.example/article'),{code:'ECONNRESET'});
 assert.equal(lookups,2);assert.equal(connections.length,2);
 const cycle=[];
 const loop=createSafeFetcher({lookupAddress:async()=>addresses('93.184.216.34'),httpsClient:transport([
  {error:networkError('ECONNRESET')},
  {status:302,headers:{location:'https://second.example/article'}},
  {status:302,headers:{location:'https://first.example/article#new-fragment'}},
  {error:networkError('ECONNRESET')},
  {body:'must not retry first URL twice'},
 ],cycle)});
 await assert.rejects(loop('https://first.example/article'),{code:'ECONNRESET'});
 assert.deepEqual(cycle.map(item=>item.host),['first.example','first.example','second.example','first.example']);
});

test('a DNS answer changing to private on retry blocks the second connection', async () => {
 let lookups=0;const connections=[];
 const read=createSafeFetcher({lookupAddress:async()=>addresses(++lookups===1?'93.184.216.34':'10.0.0.1'),httpsClient:transport([{error:networkError('ECONNRESET')},{body:'private content must not be requested'}],connections)});
 await assert.rejects(read('https://retry.example/article'),{code:'UNSAFE_URL'});
 assert.equal(lookups,2);assert.equal(connections.length,1);
});

test('caller abort stops before DNS or immediately after an in-flight reset without retrying', async () => {
 const already=new AbortController();const reason=new DOMException('user cancelled','AbortError');already.abort(reason);
 let lookups=0;const connections=[];
 const controller=new AbortController();
 const read=createSafeFetcher({lookupAddress:async()=>{lookups++;return addresses('93.184.216.34')},httpsClient:transport([{onRequest:()=>controller.abort(reason),error:networkError('ECONNRESET')},{body:'must not retry'}],connections)});
 await assert.rejects(read('https://retry.example/article',0,{signal:already.signal}),error=>error===reason);
 assert.equal(lookups,0);assert.equal(connections.length,0);
 await assert.rejects(read('https://retry.example/article',0,{signal:controller.signal}),error=>error===reason);
 assert.equal(lookups,1);assert.equal(connections.length,1);
 const dnsController=new AbortController();let dnsReads=0;
 const stoppedInDNS=createSafeFetcher({lookupAddress:async()=>{dnsReads++;dnsController.abort(reason);return addresses('93.184.216.34')},httpsClient:transport([{body:'must not connect'}],connections)});
 await assert.rejects(stoppedInDNS('https://retry.example/article',0,{signal:dnsController.signal}),error=>error===reason);
 assert.equal(dnsReads,1);assert.equal(connections.length,1);
 const fakeIPController=new AbortController();let publicDNSReads=0;
 const stoppedBeforeDoH=createSafeFetcher({lookupAddress:async()=>{fakeIPController.abort(reason);return addresses('198.18.0.8')},queryPublicDNS:async()=>{publicDNSReads++;return addresses('93.184.216.34')},httpsClient:transport([],[])});
 await assert.rejects(stoppedBeforeDoH('https://retry.example/article',0,{signal:fakeIPController.signal}),error=>error===reason);
 assert.equal(publicDNSReads,0);
});

test('unsafe URLs, HTTP errors, unsupported content and oversized bodies never receive a network retry', async () => {
 let privateLookups=0;
 const unsafe=createSafeFetcher({lookupAddress:async()=>{privateLookups++;return addresses('10.0.0.1')},httpsClient:transport([],[])});
 await assert.rejects(unsafe('http://127.0.0.1/private'),{code:'UNSAFE_URL'});
 assert.equal(privateLookups,0);
 await assert.rejects(unsafe('https://private.example/article'),{code:'UNSAFE_URL'});
 assert.equal(privateLookups,1);
 for(const reply of [
  {status:404},
  {status:503},
  {headers:{'content-type':'application/json'},body:'{}'},
  {body:'x'.repeat(2_000_001)},
  {error:networkError('ECONNREFUSED')},
 ]) {
  let lookups=0;const connections=[];
  const read=createSafeFetcher({lookupAddress:async()=>{lookups++;return addresses('93.184.216.34')},httpsClient:transport([reply,{body:'must not retry'}],connections)});
  const expected=reply.error?'ECONNREFUSED':reply.body?.length>2_000_000?'BODY_TOO_LARGE':'FETCH_FAILED';
  await assert.rejects(read('https://retry.example/article'),{code:expected});
  assert.equal(lookups,1,expected);assert.equal(connections.length,1,expected);
 }
});
