import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { LauncherLink } from '../src/transport.js';
import { ChatBridge } from '../src/chat.js';
import { ContentStore } from '../src/content.js';
import { createMockLauncher } from '../examples/mock-launcher.mjs';

function wait(emitter, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const listener = value => { if (predicate(value)) { clearTimeout(expiry); emitter.off(event, listener); resolve(value); } };
    const expiry = setTimeout(() => { emitter.off(event, listener); reject(new Error(`Timeout: ${event}`)); }, 3000);
    emitter.on(event, listener);
  });
}
function fixture() {
  const events = [
    { seq: 0, type: 'user/message', time: 1, surfaceOp: 'append', data: { id: 'user-1', content: [{ type: 'text', text: '中文😀' }] } },
    { seq: 1, type: 'assistant/message', time: 2, surfaceOp: 'append', data: { id: 'assistant-1', content: [
      { type: 'reasoning', text: '推理' }, { type: 'text', text: '答案' }, { type: 'tool-call', id: 'call-1', name: 'read', arguments: { path: 'a' } },
      { type: 'image', attachment: { id: 'img-1', mediaType: 'image/png' } }] } },
    { seq: 2, type: 'tool/result', time: 3, surfaceOp: 'append', data: { callId: 'call-1', content: [{ type: 'text', text: '工具输出' }], status: 'success' } },
  ];
  const bus = new EventEmitter(), updates = new EventEmitter();
  const sessions = new Map([['session-1', { id: 'session-1', cwd: 'C:/test' }]]);
  const agentMap=new Map(),approvalHandlers=new Map();
  const state = { approvalHandlers, agentMap, archived:[], questions:[], prompts: [], cancelled: [], queued: [], follows: 0, closed: 0 };
  const controller = {
    async inspect(sessionId) { if (!sessions.has(sessionId)) throw { code: 'session/not-found', message: 'Missing' }; return { meta: sessions.get(sessionId), events }; },
    async list() { return { items: [...sessions.values()].map(meta => ({ sessionId: meta.id,cwd:meta.cwd,origin:meta.origin, updatedAt: 1, projections: { values:{title:'会话'} } })) }; },
    async projections() { return { asOfSeq: events.length - 1, values: { model: { name: 'fake' },userQuestions:{active:state.questions} } }; },
    async page(request) { if (request.address.kind === 'subagent' && request.address.parentSessionId !== 'session-1') throw { code: 'subagent/unauthorized', message: 'Parent mismatch' };
      const end = Math.min(request.throughSeq + 1, request.beforeSeq ?? events.length); const start = Math.max(0, end - request.maxMessages);
      return { records: events.slice(start, end).map(event => ({ type: 'event', event })), hasMore: start > 0 }; },
    async create(p) { const sessionId = p.sessionId ?? 'new-session'; sessions.set(sessionId, { id: sessionId, cwd: p.cwd ?? 'C:/test' }); return { sessionId }; },
    async rename(p) { state.renamed = p; return { title: p.title, seq: 3 }; },
    async fork(p) { state.forked = p; return { sessionId: 'forked' }; },
    async selectModel(p) { state.model = p; return { selected: p }; },
    async prompt(p) { state.prompts.push(p); return { accepted: true }; },
    cancel(p) { state.cancelled.push(p); return { accepted: true }; },
    updateQueue(p) { state.queued.push(p); return { accepted: true }; },
    async attachment() { return { attachment: { id: 'img-1' }, data: Buffer.from('image fixture').toString('base64') }; },
    async search(p){state.query=p.query;return {items:[{sessionId:'session-1',snippet:'literal result'}],hasMore:false};},
    async resolveAgent(sessionId){if(!agentMap.has(sessionId))agentMap.set(sessionId,{id:sessionId,ctx:{on(event,fn){approvalHandlers.set(sessionId,fn);return ()=>approvalHandlers.delete(sessionId);}}});return {agent:agentMap.get(sessionId)};},
    async modelCatalog() { return { groups: [{ id: 'test', models: [{ id: 'fake' }] }] }; },
    async *follow(request, signal) {
      state.follows++; const queue = []; let wake;
      const listener = frame => { queue.push(frame); wake?.(); }, onAbort = () => wake?.();
      updates.on('frame', listener); signal.addEventListener('abort', onAbort);
      try {
        yield { type: 'snapshot', header: sessions.get(request.address.sessionId), cursor: events.at(-1).seq,
          records: events.map(event => ({ type: 'event', event })), hasMore: false, projections: { asOfSeq: 2, values: {} }, assistantStream: { revision: 0 } };
        while (!signal.aborted) {
          if (queue.length) yield queue.shift(); else await new Promise(resolve => { wake = resolve; });
        }
      } finally { updates.off('frame', listener); signal.removeEventListener('abort', onAbort); state.closed++; }
    },
  };
  const services={approval:{},agents:{get:id=>agentMap.get(id)},attachments:{async *readFileStream(ref,signal){signal.throwIfAborted();if(state.fileReadFailure)throw state.fileReadFailure;for(let offset=0;offset<state.downloadBytes.length;offset+=65536)yield state.downloadBytes.subarray(offset,offset+65536);}},
    sessionQuery:{config:{openAt:'first-search'},async readSurface(id){return {session:sessions.get(id),capturedThroughSeq:state.contextCut??events.at(-1).seq,events:events.filter(e=>(state.currentSeqs??[0,1,2]).includes(e.seq))};},async searchSessions(p){state.query=p.query;if(state.searchFailure)throw state.searchFailure;if(state.searchPages)return state.searchPages[p.cursor??'first'];return {items:[{header:{id:'session-1'},bestMatch:{sessionId:'session-1',seq:0,type:'user/message',surface:'current',time:1,snippet:'literal result'}}]};}},
    fileUploads:{async uploadStream(r){const chunks=[];for await(const c of r.data)chunks.push(c);state.file=Buffer.concat(chunks);state.uploadSession=r.sessionId;return {receiptId:'receipt-1',file:{attachmentId:createHash('sha256').update(state.file).digest('hex'),bytes:state.file.length,name:r.name}};}},
    workspaceRegistry:{list(){return state.workspaces??[];},get(id){return this.list().find(w=>w.id===id);},get pinnedSessionIds(){return state.pins??=[];},async pinSession(id){if(state.archived.includes(id)){const e=new Error();e.constructor={name:'WorkspaceArchivedSessionPinError'};throw e;}if(!this.pinnedSessionIds.includes(id)){state.pins.unshift(id);bus.emit('domain/changed',{domain:'workspace'});}},async unpinSession(id){state.pins=this.pinnedSessionIds.filter(v=>v!==id);bus.emit('domain/changed',{domain:'workspace'});},get archivedSessionIds(){return state.archived;},async archiveSession(id){if(state.busy){const e=new Error();e.constructor={name:'WorkspaceActiveSessionError'};throw e;}if(!state.archived.includes(id))state.archived.push(id);},async unarchiveSession(id){state.archived=state.archived.filter(v=>v!==id);}},
    userQuestions:{answer(agent,callId,answer){state.answer={agent,callId,answer};return true;}}
  };
  const ctx = { sessionController: controller, get: name => services[name],
    on(event, fn) { bus.on(event, fn); return () => bus.off(event, fn); } };
  return { ctx, services, events, sessions, state, updates, bus };
}
async function setup(t) {
  const launcher = await createMockLauncher({ token: 'chat-test-only-not-production' });
  const link = new LauncherLink({ url: launcher.url, token: 'chat-test-only-not-production', instanceId: 'chat-test', reconnectMinMs: 10, reconnectMaxMs: 20 }, { env: {} });
  const f = fixture(), bridge = new ChatBridge(f.ctx, link);
  t.after(async () => { link.stop(); await bridge.dispose(); await launcher.close(); });
  const ready = wait(link, 'ready'); link.start(); await ready;
  let sequence = 0;
  async function rpc(method, params = {}) {
    const id = `request-${++sequence}`;
    const response = wait(launcher.wss, 'frame', f => f.message.type === 'response' && f.message.id === id);
    launcher.send('chat-test', { type: 'request', id, method, params }); return (await response).message;
  }
  async function call(method, params) { const response = await rpc(method, params); assert.equal(response.ok, true, JSON.stringify(response.error)); return response.result; }
  return { ...f, launcher, link, bridge, rpc, call };
}
test('queued text edit preserves native attachment refs and rejects stale content',async t=>{
  const f=await setup(t),owner=await f.ctx.sessionController.resolveAgent('session-1');
  const image={type:'image',attachment:{attachmentId:'sha256:image',mediaType:'image/png',width:4,height:4,bytes:123}};
  const file={type:'file',attachment:{attachmentId:'sha256:file',name:'example.txt',bytes:42}};
  let message={id:'mixed-item',role:'user',source:{kind:'user',rpcId:'stable-input'},content:[{type:'text',text:'before'},image,{type:'text',text:'more'},file]};
  owner.agent.inbox={get nextTurn(){return message?[message]:[];},nextStep:[],replace(id,value){if(!message||id!==message.id)return false;message=value;return true;}};
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
  const request={sessionId:'session-1',itemId:message.id,text:'edited',expectedContentHash:hash(message.content)};
  assert.equal((await f.rpc('session.queue.update',{sessionId:'session-1',itemId:message.id,action:{kind:'edit',content:[{type:'text',text:'unsafe replacement'}]}})).error.code,'QUEUE_ATTACHMENT_EDIT_REQUIRED');
  const result=await f.call('session.queue.editText',request);assert.equal(result.contentHash,hash(message.content));assert.equal(message.id,'mixed-item');assert.equal(message.source.rpcId,'stable-input');
  assert.deepEqual(message.content,[{type:'text',text:'edited'},image,file]);assert.ok(Object.isFrozen(message.content[1].attachment));
  assert.equal((await f.rpc('session.queue.editText',request)).error.code,'QUEUE_CONTENT_CHANGED');
  await f.call('session.queue.editText',{...request,text:'',expectedContentHash:hash(message.content)});assert.deepEqual(message.content,[image,file]);
  message={...message,source:{kind:'runtime-context'}};assert.equal((await f.rpc('session.queue.editText',{...request,expectedContentHash:hash(message.content)})).error.code,'QUEUE_NOT_EDITABLE');
  message={...message,source:{kind:'user'},content:[{type:'future-block',value:1}]};assert.equal((await f.rpc('session.queue.editText',{...request,expectedContentHash:hash(message.content)})).error.code,'QUEUE_NOT_EDITABLE');
  message=null;assert.equal((await f.rpc('session.queue.editText',request)).error.code,'session/queue-item-not-found');
});
test('file stream downloads require a declared session ref and verify before final chunk',async t=>{
 const f=await setup(t);f.state.downloadBytes=Buffer.from('file stream bytes'.repeat(11000));const bytes=f.state.downloadBytes;
 const attachmentId='sha256:'+createHash('sha256').update(bytes).digest('hex'),ref={attachmentId,name:'fixture.txt',bytes:bytes.length};
 f.events.push({seq:3,type:'user/message',data:{id:'file-user',role:'user',content:[{type:'file',attachment:ref}]}});
 assert.equal((await f.rpc('file.download.begin',{sessionId:'session-1',attachmentId:'sha256:'+'a'.repeat(64)})).error.code,'FILE_NOT_REFERENCED');
 const opening=await f.call('file.download.begin',{sessionId:'session-1',attachmentId});const chunks=[];let offset=0,part;
 do{part=await f.call('file.download.read',{downloadId:opening.downloadId,offset});assert.equal(part.offset,offset);assert.equal(part.verified,part.eof);chunks.push(Buffer.from(part.data,'base64'));const repeat=await f.call('file.download.read',{downloadId:opening.downloadId,offset});assert.equal(repeat.data,part.data);assert.equal(repeat.nextOffset,part.nextOffset);offset=part.nextOffset;}while(!part.eof);
 assert.deepEqual(Buffer.concat(chunks),bytes);assert.equal(offset,ref.bytes);await f.call('file.download.release',{downloadId:opening.downloadId});
 assert.equal((await f.rpc('file.download.read',{downloadId:opening.downloadId,offset:0})).error.code,'DOWNLOAD_EXPIRED');
 f.state.downloadBytes=Buffer.from('wrong content');const broken=await f.call('file.download.begin',{sessionId:'session-1',attachmentId});assert.equal((await f.rpc('file.download.read',{downloadId:broken.downloadId,offset:0})).error.code,'ATTACHMENT_CORRUPT');
 f.state.downloadBytes=Buffer.alloc(bytes.length,42);const corrupt=await f.call('file.download.begin',{sessionId:'session-1',attachmentId});let corruptOffset=0,corruptFailure;
 while(!corruptFailure){const response=await f.rpc('file.download.read',{downloadId:corrupt.downloadId,offset:corruptOffset});if(response.ok){assert.equal(response.result.verified,false);corruptOffset=response.result.nextOffset;}else corruptFailure=response.error.code;}
 assert.equal(corruptFailure,'ATTACHMENT_CORRUPT');
 f.state.downloadBytes=bytes;const expired=await f.call('file.download.begin',{sessionId:'session-1',attachmentId});f.bridge.downloads.get(expired.downloadId).expiresAt=0;
 assert.equal((await f.rpc('file.download.read',{downloadId:expired.downloadId,offset:0})).error.code,'DOWNLOAD_EXPIRED');
});
test('archived subscription never starts the native activating follow stream',async t=>{
 const f=await setup(t);f.state.archived.push('session-1');assert.equal((await f.rpc('session.subscribe',{sessionId:'session-1',subscriptionId:'archived-view'})).error.code,'ARCHIVED_READ_ONLY');assert.equal(f.state.follows,0);
 assert.equal((await f.call('session.get',{sessionId:'session-1'})).value.cursor,2);assert.ok((await f.call('session.page',{sessionId:'session-1'})).value.records.length);
});
test('native cross-session search pages archive hits, caches retries and rejects stale scopes',async t=>{
 const f=await setup(t);f.sessions.set('archived',{id:'archived',cwd:'C:/archive'});f.state.archived.push('archived');
 const hit=id=>({header:{id},bestMatch:{sessionId:id,seq:10,type:'user/message',surface:'current',time:5,snippet:'needle'}});
 f.state.searchPages={first:{items:[hit('archived')],nextCursor:'native-second'},'native-second':{items:[hit('session-1')]}};
 const first=(await f.call('session.search',{query:'needle',limit:1})).value;assert.equal(first.items.length,0);assert.equal(first.hasMore,true);assert.equal(first.coverage.moreMeans,'provider-candidates');
 const page=(await f.call('session.search',{cursor:first.nextCursor})).value;assert.equal(page.items[0].match.seq,10);assert.equal(page.items[0].title,'会话');assert.equal(page.hasMore,false);
 assert.deepEqual((await f.call('session.search',{cursor:first.nextCursor})).value,page);
 const all=(await f.call('session.search',{query:'needle',includeArchived:true,limit:1})).value;assert.equal(all.items[0].archived,true);assert.equal(all.items[0].cwd,'C:/archive');
 f.state.archived=[];assert.equal((await f.rpc('session.search',{cursor:all.nextCursor})).error.code,'SEARCH_CURSOR_STALE');
 f.state.searchFailure={code:'SESSION_QUERY_STALE_CURSOR'};assert.equal((await f.rpc('session.search',{query:'needle'})).error.code,'SEARCH_CURSOR_STALE');f.state.searchFailure=null;
 const cancel=(await f.call('session.search',{query:'needle',limit:1})).value;assert.equal((await f.call('session.search.cancel',{cursor:cancel.nextCursor})).cancelled,true);
 assert.equal((await f.rpc('session.search',{cursor:cancel.nextCursor})).error.code,'SEARCH_CURSOR_EXPIRED');
 assert.equal((await f.rpc('session.search',{query:'needle',limit:21})).error.code,'INVALID_PARAMS');
 f.services.sessionQuery.config.maxLimit=1;assert.equal((await f.call('session.search',{query:'needle'})).value.budget.limit,1);
 for(const entry of f.bridge.searchPager.entries.values())entry.expiresAt=0;f.bridge.searchPager.prune();assert.equal(f.bridge.searchPager.entries.size,0);assert.equal(f.bridge.searchPager.families.size,0);
});

test('complete native history, stable list paging and event cut pagination', async t => {
  const f = await setup(t); f.sessions.set('session-2', { id: 'session-2', cwd: 'C:/test' });
  const first = (await f.call('session.list', { limit: 1 })).value;
  f.sessions.delete('session-2');
  const last = (await f.call('session.list', { cursor: first.nextCursor, limit: 1 })).value;
  assert.equal(last.items[0].sessionId, 'session-2'); assert.equal(last.hasMore, false);
  const get = (await f.call('session.get', { sessionId: 'session-1' })).value;
  assert.equal(get.cursor, 2); assert.equal(get.header.cwd, 'C:/test');
  const page = (await f.call('session.page', { sessionId: 'session-1', maxMessages: 2 })).value;
  assert.deepEqual(page.records[0].event, f.events[1]); assert.equal(page.nextBeforeSeq, 1);
  const older = (await f.call('session.page', { sessionId: 'session-1', throughSeq: page.throughSeq, beforeSeq: page.nextBeforeSeq })).value;
  assert.equal(older.records[0].event.seq, 0);
  const prefix = (await f.call('session.events', { sessionId: 'session-1', afterSeq: -1, limit: 2 })).value;
  const suffix = (await f.call('session.events', { sessionId: 'session-1', afterSeq: prefix.nextAfterSeq, throughSeq: prefix.throughSeq })).value;
  assert.deepEqual([...prefix.records, ...suffix.records].map(r => r.event), f.events);
  assert.deepEqual((await f.call('session.event', { sessionId: 'session-1', seq: 1 })).value.event, f.events[1]);
  assert.equal((await f.rpc('session.events', { sessionId: 'session-1', afterSeq: 10 })).error.code, 'CURSOR_AHEAD');
});

test('long Chinese/emoji message round-trips losslessly with SHA256', async t => {
  const f = await setup(t); f.events[1].data.content[1].text = '完整中文😀🧪'.repeat(25000);
  const payload = await f.call('session.event', { sessionId: 'session-1', seq: 1 });
  assert.equal(payload.kind, 'content-ref');
  const buffers = []; let offset = 0;
  while (offset < payload.totalBytes) {
    const chunk = await f.call('content.read', { contentId: payload.contentId, offset });
    assert.ok(chunk.nextOffset - offset <= 49152); buffers.push(Buffer.from(chunk.data, 'base64')); offset = chunk.nextOffset;
  }
  const bytes = Buffer.concat(buffers); assert.equal(bytes.length, payload.totalBytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), payload.sha256);
  assert.deepEqual(JSON.parse(bytes.toString()).event, f.events[1]);
  assert.equal((await f.call('content.release', { contentId: payload.contentId })).released, true);
  assert.equal((await f.rpc('content.read', { contentId: payload.contentId })).error.code, 'CONTENT_EXPIRED');
});

test('prompt business ID is independent of transport ID, deduplicates and checks conflicts', async t => {
  const f = await setup(t);
  const p = { sessionId: 'session-1', clientRequestId: 'phone-prompt-1', content: [{ type: 'text', text: '你好' }], clientTimeZone: 'America/New_York' };
  const [one, two] = await Promise.all([f.call('session.prompt', p), f.call('session.prompt', p)]);
  assert.deepEqual(one, { accepted: true, clientRequestId: 'phone-prompt-1' }); assert.deepEqual(two, one);
  assert.equal(f.state.prompts.length, 1); assert.equal(f.state.prompts[0].requestId, p.clientRequestId);
  assert.equal((await f.rpc('session.prompt', { ...p, content: [{ type: 'text', text: 'different' }] })).error.code, 'ID_CONFLICT');
  await f.call('session.cancel', { sessionId: 'session-1' }); assert.equal(f.state.cancelled.length, 1);
  await f.call('session.queue.update', { sessionId: 'session-1', itemId: 'queued', action: { kind: 'edit', content: [{ type: 'text', text: '改写' }] } });
  assert.equal(f.state.queued[0].action.content[0].text, '改写');
});

test('subscribe opening precedes live events; replay cut and disconnect cleanup', async t => {
  const f = await setup(t), frames = [];
  f.launcher.wss.on('frame', ({ message }) => frames.push(message));
  const subscribed = await f.call('session.subscribe', { subscriptionId: 'subscription-1', sessionId: 'session-1', afterSeq: 0 });
  assert.equal(subscribed.opening.value.type, 'snapshot'); assert.deepEqual(subscribed.replay, { afterSeq: 0, throughSeq: 2 });
  const frame = { type: 'assistant-stream', frame: { type: 'chunk', index: 0, revision: 1, attemptId: 'attempt', chunk: { type: 'text', text: '实时😀' } } };
  const event = wait(f.launcher.wss, 'frame', f => f.message.event === 'session.follow'); f.updates.emit('frame', frame);
  assert.deepEqual((await event).message.data.frame.value, frame);
  assert.ok(frames.findIndex(f => f.type === 'response') < frames.findIndex(f => f.event === 'session.follow'));
  await f.call('session.unsubscribe', { subscriptionId: 'subscription-1' }); await sleep(10);
  assert.equal(f.state.closed, 1); assert.equal(f.bridge.subscriptions.size, 0);
  await f.call('session.subscribe', { subscriptionId: 'subscription-2', sessionId: 'session-1' });
  f.events[1].data.large = 'x'.repeat(150000);
  await f.call('session.event', { sessionId: 'session-1', seq: 1 });
  const ready = wait(f.link, 'ready'); f.launcher.instances.get('chat-test').socket.terminate(); await ready;
  assert.equal(f.bridge.subscriptions.size, 0); assert.equal(f.bridge.content.bytes, 0);
  assert.equal(f.state.closed, 2);
});

test('creation, rename, fork, model and attachment operations preserve native values', async t => {
  const f = await setup(t);
  assert.equal((await f.call('session.create', { sessionId: 'named', cwd: 'C:/project' })).sessionId, 'named');
  assert.equal((await f.call('session.rename', { sessionId: 'named', title: '标题' })).title, '标题');
  assert.equal((await f.call('session.fork', { sessionId: 'named', atSeq: 1 })).sessionId, 'forked');
  await f.call('session.selectModel', { sessionId: 'named', provider: 'test', model: 'fake', reasoningEffort: 'high' });
  assert.equal(f.state.model.reasoningEffort, 'high');
  assert.equal((await f.call('model.catalog')).value.groups[0].id, 'test');
  assert.equal((await f.call('session.attachment', { sessionId: 'named', attachmentId: 'img-1' })).value.attachment.id, 'img-1');
  assert.equal((await f.call('session.projections', { sessionId: 'named' })).value.asOfSeq, 2);
});

test('invalid input, nonexistent sessions and subagent ownership are rejected', async t => {
  const f = await setup(t);
  const requests = [ ['session.list', { limit: 101 }], ['session.page', { sessionId: 'session-1', maxMessages: 0 }],
    ['session.create', { cwd: 'C:/a', workspaceId: 'w' }], ['session.get', { sessionId: '../outside' }],
    ['session.event', { sessionId: 'session-1' }], ['session.prompt', { sessionId: 'session-1', clientRequestId: 'id', content: [{ type: 'text', text: ' ' }] }],
    ['session.prompt', { sessionId: 'session-1', clientRequestId: 'id', content: [{ type: 'unknown' }] }],
    ['session.cancel', { sessionId: 'session-1', extra: true }], ['session.queue.update', { sessionId: 'session-1', itemId: 'q', action: { kind: 'invalid' } }],
  ];
  for (const [method, params] of requests) assert.equal((await f.rpc(method, params)).error.code, 'INVALID_PARAMS', method);
  assert.equal((await f.rpc('session.get', { sessionId: 'missing' })).error.code, 'session/not-found');
  f.sessions.set('child', { id: 'child', origin: 'subagent' });
  assert.equal((await f.rpc('session.get', { sessionId: 'child' })).error.code, 'SUBAGENT_ADDRESS_REQUIRED');
  const wrong = { kind: 'subagent', childSessionId: 'child', parentSessionId: 'wrong', mode: 'unknown' };
  assert.equal((await f.rpc('session.get', { address: wrong })).error.code, 'subagent/unauthorized');
  assert.equal((await f.rpc('session.subscribe', { subscriptionId: 'ahead', sessionId: 'session-1', afterSeq: 100 })).error.code, 'CURSOR_AHEAD');
  assert.equal(f.bridge.subscriptions.size, 0);
});

test('content expiry/capacity are bounded and never silently truncate', () => {
  let now = 0; const store = new ContentStore({ inlineBytes: 8, maxBytes: 100, ttlMs: 10, now: () => now });
  const a = store.pack('x'.repeat(60)), b = store.pack('y'.repeat(60));
  assert.throws(() => store.read(a.contentId), e => e.code === 'CONTENT_EXPIRED');
  assert.ok(store.bytes <= 100); now = 11;
  assert.throws(() => store.read(b.contentId), e => e.code === 'CONTENT_EXPIRED');
  assert.equal(store.bytes, 0);
  assert.throws(() => store.pack('z'.repeat(101)), e => e.code === 'CONTENT_TOO_LARGE');
});


test('bounded chunk upload preserves bytes, enforces offsets/hash and returns native receipt',async t=>{
 const f=await setup(t),bytes=Buffer.from('文件内容🙂'.repeat(18000)),sha256=createHash('sha256').update(bytes).digest('hex');
 const upload=await f.call('file.upload.begin',{sessionId:'session-1',name:'file.txt',totalBytes:bytes.length,sha256});
 for(let offset=0;offset<bytes.length;offset+=49152){const data=bytes.subarray(offset,offset+49152).toString('base64');await f.call('file.upload.chunk',{uploadId:upload.uploadId,offset,data});if(offset===0)await f.call('file.upload.chunk',{uploadId:upload.uploadId,offset,data});}
 const receipt=await f.call('file.upload.commit',{uploadId:upload.uploadId});assert.equal(receipt.receiptId,'receipt-1');assert.deepEqual(f.state.file,bytes);assert.equal(f.state.uploadSession,'session-1');
 assert.deepEqual(await f.call('file.upload.commit',{uploadId:upload.uploadId}),receipt);
 await f.call('file.upload.abort',{uploadId:upload.uploadId});assert.equal((await f.rpc('file.upload.commit',{uploadId:upload.uploadId})).error.code,'UPLOAD_EXPIRED');
 const bad=await f.call('file.upload.begin',{sessionId:'session-1',name:'bad.txt',totalBytes:1,sha256:'0'.repeat(64)});await f.call('file.upload.chunk',{uploadId:bad.uploadId,offset:0,data:'YQ=='});assert.equal((await f.rpc('file.upload.commit',{uploadId:bad.uploadId})).error.code,'UPLOAD_HASH');
 assert.equal((await f.rpc('file.upload.begin',{sessionId:'session-1',name:'../escape',totalBytes:1,sha256})).error.code,'INVALID_PARAMS');
 assert.equal((await f.rpc('file.upload.begin',{sessionId:'session-1',name:'big',totalBytes:16777217,sha256})).error.code,'INVALID_PARAMS');
 f.sessions.set('child',{id:'child',origin:'subagent'});assert.equal((await f.rpc('file.upload.begin',{sessionId:'child',name:'a',totalBytes:1,sha256})).error.code,'SUBAGENT_ADDRESS_REQUIRED');
});
test('native search, reversible archive and continued-question validation',async t=>{
 const f=await setup(t);assert.equal((await f.call('session.search',{query:'中文'})).value.items[0].sessionId,'session-1');assert.equal(f.state.query,'中文');
 f.state.busy=true;assert.equal((await f.rpc('session.archive',{sessionId:'session-1'})).error.code,'SESSION_ACTIVE');assert.equal(f.state.archived.length,0);
 f.state.busy=false;await f.call('session.archive',{sessionId:'session-1'});assert.deepEqual((await f.call('session.archive.list',{})).sessionIds,['session-1']);assert.ok(f.sessions.has('session-1'));await f.call('session.unarchive',{sessionId:'session-1'});assert.equal(f.state.archived.length,0);
 const answer={sessionId:'session-1',callId:'call-q',answers:[{id:'q',selected:['Yes']}]};assert.equal((await f.call('session.question.answer',answer)).answered,false);
 f.state.questions=[{callId:'call-q',state:'open',questions:[{id:'q',options:[{label:'Yes'}]}]}];assert.equal((await f.rpc('session.question.answer',answer)).error.code,'QUESTION_OPEN');
 f.state.questions[0].state='continued';assert.equal((await f.call('session.question.answer',answer)).answered,true);assert.equal(f.state.answer.agent.id,'session-1');
 assert.equal((await f.rpc('session.question.answer',{...answer,answers:[{id:'q',selected:['Unknown']}]})).error.code,'INVALID_PARAMS');
});

test('disabled native index is not advertised and upload allocations are bounded',async t=>{
 const disabled=fixture();disabled.services.sessionQuery={config:{openAt:'never'}};
 const link=new LauncherLink({enabled:false},{env:{}}),bridge=new ChatBridge(disabled.ctx,link);assert.equal(link.methods.has('session.search'),false);await bridge.dispose();link.stop();
 const f=await setup(t),spec={sessionId:'session-1',name:'a',totalBytes:1,sha256:'0'.repeat(64)};
 const ids=[];for(let i=0;i<4;i++)ids.push((await f.call('file.upload.begin',spec)).uploadId);
 assert.equal((await f.rpc('file.upload.begin',spec)).error.code,'RESOURCE_LIMIT');
 assert.equal((await f.rpc('file.upload.chunk',{uploadId:ids[0],offset:0,data:'YQ'})).error.code,'INVALID_PARAMS');
 assert.equal((await f.rpc('file.upload.commit',{uploadId:ids[0]})).error.code,'UPLOAD_INCOMPLETE');
 f.bridge.uploads.get(ids[0]).expiresAt=0;assert.equal((await f.rpc('file.upload.commit',{uploadId:ids[0]})).error.code,'UPLOAD_EXPIRED');
});

test('scoped one-shot approvals reject stale decisions and fail closed on disconnect',async t=>{
 const f=await setup(t);await f.call('session.approval.subscribe',{sessionId:'session-1',subscriptionId:'approval-owner'});
 assert.equal((await f.rpc('session.approval.subscribe',{sessionId:'session-1',subscriptionId:'other-owner'})).error.code,'BUSY');
 const signal=new AbortController(),handler=f.state.approvalHandlers.get('session-1'),agent=f.state.agentMap.get('session-1');
 const event=wait(f.launcher.wss,'frame',f=>f.message.event==='session.approval.request');
 const result=handler({agent,toolName:'fixture_tool',callId:'call-approve',reason:'Test grant',signal:signal.signal},()=>Promise.resolve('unavailable'));
 const frame=(await event).message.data,requestId=frame.request.value.requestId;
 assert.equal((await f.call('session.approval.pending',{subscriptionId:'approval-owner'})).value.requests[0].requestId,requestId);
 assert.equal((await f.rpc('session.approval.decide',{subscriptionId:'wrong',requestId,decision:'allowed-once'})).error.code,'INTERACTION_ENDED');
 assert.equal((await f.rpc('session.approval.decide',{subscriptionId:'approval-owner',requestId,decision:'always'})).error.code,'INVALID_PARAMS');
 await f.call('session.approval.decide',{subscriptionId:'approval-owner',requestId,decision:'allowed-once'});assert.equal(await result,'allowed-once');
 assert.equal((await f.rpc('session.approval.decide',{subscriptionId:'approval-owner',requestId,decision:'allowed-once'})).error.code,'INTERACTION_ENDED');
 const cancelled=handler({agent,toolName:'fixture_tool',signal:signal.signal},()=>Promise.resolve('unavailable'));signal.abort();assert.equal(await cancelled,'cancelled');
 const abandoned=handler({agent,toolName:'fixture_tool'},()=>Promise.resolve('unavailable'));await f.call('session.approval.unsubscribe',{subscriptionId:'approval-owner'});assert.equal(await abandoned,'unavailable');
});


test('context windows validate the entire native current surface at a stable cut',async t=>{
 const f=await setup(t);f.services.sessionQuery.config.openAt='never';for(let seq=3;seq<80;seq++)f.events.push({seq,type:'tool/result',data:{content:[]}});
 f.state.currentSeqs=[1,2];const page=(await f.call('session.context',{sessionId:'session-1',seq:0,before:0,after:2})).value;
 assert.equal(page.status,'not-current-match');assert.equal(page.target.current,false);assert.equal(page.throughSeq,79);assert.equal(page.records.length,3);assert.equal(page.nextSeq,3);assert.equal(page.coverage.completeHistory,false);
 const next=(await f.call('session.context',{sessionId:'session-1',seq:page.nextSeq,throughSeq:page.throughSeq,before:0,after:25})).value;
 assert.equal(next.startSeq,3);assert.equal(next.endSeq,28);assert.equal(next.previousSeq,2);
 assert.equal((await f.rpc('session.context',{sessionId:'session-1',seq:1,after:26})).error.code,'INVALID_PARAMS');
 assert.equal((await f.rpc('session.context',{sessionId:'session-1',seq:1,throughSeq:78})).error.code,'CONTEXT_STALE');
 f.state.contextCut=80;assert.equal((await f.rpc('session.context',{sessionId:'session-1',seq:1})).error.code,'CONTEXT_STALE');
 f.state.contextCut=79;f.sessions.get('session-1').origin='subagent';assert.equal((await f.rpc('session.context',{sessionId:'session-1',seq:1})).error.code,'SUBAGENT_ADDRESS_REQUIRED');
 assert.equal((await f.rpc('session.context',{sessionId:'../outside',seq:1})).error.code,'INVALID_PARAMS');assert.equal(f.state.follows,0);assert.equal(f.state.agentMap.size,0);assert.equal(f.services.sessionQuery.config.openAt,'never');
});


test('methods registered between hello and welcome are reconciled on ready and reconnect',async t=>{
 const launcher=await createMockLauncher({token:'capability-race-test-only',welcomeDelayMs:60});
 const link=new LauncherLink({url:launcher.url,token:'capability-race-test-only',instanceId:'race',reconnectMinMs:10,reconnectMaxMs:20},{env:{}});
 t.after(async()=>{await link.stop();await launcher.close();});
 const registered=wait(launcher.wss,'registered'),ready=wait(link,'ready');const frames=[];launcher.wss.on('frame',f=>frames.push(f.message));link.start();
 const initial=await registered;assert.equal(initial.info.methods.includes('session.context'),false);assert.equal(link.state,'handshaking');
 link.registerMethod('session.context',()=>({ok:true}));assert.equal(frames.some(m=>m.event==='capabilities.changed'),false);await ready;
 await waitUntil(()=>frames.some(m=>m.event==='capabilities.changed'&&m.data.methods.includes('session.context')));
 const reconcile=frames.find(m=>m.event==='capabilities.changed');assert.deepEqual(reconcile.data.methods,link.info().methods);
 const again=wait(link,'ready');launcher.instances.get('race').socket.terminate();await again;
 await waitUntil(()=>frames.filter(m=>m.event==='capabilities.changed'&&m.data.methods.includes('session.context')).length>=2);
});
async function waitUntil(predicate){for(let i=0;i<100;i++){if(predicate())return;await sleep(10);}throw new Error('Capability update missing');}


test('native pins and workspace order are shared and preserve snapshot and archive isolation',async t=>{
 const f=await setup(t);for(const [id,cwd] of [['a','C:/test'],['b','C:/test'],['elsewhere','C:/other']])f.sessions.set(id,{id,cwd});
 const workspace={id:'w',path:'C:/test',title:'workspace',sessionIds:['session-1','a','b'],async insertSessionBefore(value,before){if(!this.sessionIds.includes(value)||(before!==undefined&&!this.sessionIds.includes(before))){const e=new Error();e.constructor={name:'WorkspaceMoveInvalidError'};throw e;}if(value===before)return;this.sessionIds=this.sessionIds.filter(v=>v!==value);this.sessionIds.splice(before===undefined?this.sessionIds.length:this.sessionIds.indexOf(before),0,value);f.bus.emit('domain/changed',{domain:'workspace'});}};
 f.state.workspaces=[workspace,{id:'other',path:'C:/other',title:'other',sessionIds:['elsewhere']}];
 assert.deepEqual(await f.call('session.pin',{sessionId:'a',pinned:true}),{sessionId:'a',pinned:true,pinOrder:0});
 await f.call('session.pin',{sessionId:'b',pinned:true});await f.call('session.pin',{sessionId:'a',pinned:true});assert.deepEqual(f.state.pins,['b','a']);
 const first=(await f.call('session.list',{workspaceId:'w',sort:'manual',limit:1})).value;assert.equal(first.items[0].sessionId,'b');assert.equal(first.items[0].pinned,true);
 assert.equal((await f.rpc('session.list',{cursor:first.nextCursor,workspaceId:'other'})).error.code,'INVALID_PARAMS');
 const changed=wait(f.launcher.wss,'frame',v=>v.message.event==='session.list.changed'&&v.message.data.reason==='workspace-state');
 await f.call('workspace.insertSessionBefore',{workspaceId:'w',sessionId:'b',beforeSessionId:'session-1'});await changed;
 await f.call('session.pin',{sessionId:'a',pinned:false});await f.call('session.pin',{sessionId:'b',pinned:false});
 const manual=(await f.call('session.list',{workspaceId:'w',sort:'manual'})).value;assert.deepEqual(manual.items.map(v=>v.sessionId),['b','session-1','a']);
 const continuation=(await f.call('session.list',{cursor:first.nextCursor,limit:10})).value;assert.deepEqual(continuation.items.map(v=>v.sessionId),['a','session-1']);assert.equal(continuation.items[0].pinned,true);
 assert.equal((await f.rpc('workspace.insertSessionBefore',{workspaceId:'w',sessionId:'elsewhere'})).error.code,'WORKSPACE_MOVE_INVALID');assert.deepEqual(f.state.workspaces[1].sessionIds,['elsewhere']);
 f.state.archived.push('a');assert.equal((await f.rpc('session.pin',{sessionId:'a',pinned:true})).error.code,'ARCHIVED_READ_ONLY');assert.equal((await f.rpc('workspace.insertSessionBefore',{workspaceId:'w',sessionId:'a'})).error.code,'ARCHIVED_READ_ONLY');assert.ok(f.state.archived.includes('a'));
 const workspaces=(await f.call('workspace.list',{})).value;assert.deepEqual(workspaces.items[0].sessionIds,['b','session-1']);
 f.sessions.get('b').origin='subagent';assert.equal((await f.rpc('session.pin',{sessionId:'b',pinned:true})).error.code,'SUBAGENT_ADDRESS_REQUIRED');assert.equal((await f.rpc('session.pin',{sessionId:'../outside',pinned:true})).error.code,'INVALID_PARAMS');assert.equal((await f.rpc('session.pin',{sessionId:'session-1',pinned:'true'})).error.code,'INVALID_PARAMS');assert.equal(f.state.follows,0);
});

// This is deliberately the native event, not a bridge-only rename callback.
test('native title changes invalidate session lists and unrelated events do not', async t => {
 const f=await setup(t),received=[];
 f.launcher.wss.on('frame',v=>{if(v.message.event==='session.list.changed')received.push(v.message.data);});
 const notification=wait(f.launcher.wss,'frame',v=>v.message.event==='session.list.changed'&&v.message.data.reason==='title');
 f.bus.emit('session/event',{id:'session-1'},{type:'session/title',seq:7,data:{title:'renamed'}});
 assert.deepEqual((await notification).message.data,{sessionId:'session-1',change:'updated',reason:'title',seq:7});
 f.bus.emit('session/event',{id:'session-1'},{type:'tool/result',seq:8,data:{}});
 await sleep(30);assert.equal(received.length,1);
 await f.bridge.dispose();
 f.bus.emit('session/event',{id:'session-1'},{type:'session/title',seq:9,data:{title:'later'}});
 await sleep(30);assert.equal(received.length,1);
});
