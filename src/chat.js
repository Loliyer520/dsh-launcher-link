import { randomUUID, createHash } from 'node:crypto';
import { LinkError } from './transport.js';
import { ContentStore } from './content.js';
import { SearchPager } from './search.js';

const fail = message => { throw new LinkError('INVALID_PARAMS', message); };
function params(value, keys) {
  const p = value ?? {};
  if (typeof p !== 'object' || Array.isArray(p)) fail('Expected an object');
  for (const key of Object.keys(p)) if (!keys.includes(key)) fail(`Unknown field: ${key}`);
  return p;
}
function text(value, name, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\0/.test(value)) fail(`Invalid ${name}`);
  return value;
}
function id(value, name = 'sessionId') {
  text(value, name, 128);
  if (/[\\/]/.test(value) || value === '.' || value === '..') fail(`Invalid ${name}`);
  return value;
}
function integer(value, name, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${name}`);
  return value;
}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
function contentHash(content){return createHash('sha256').update(JSON.stringify(canonical(content)),'utf8').digest('hex');}
function immutableCopy(value){const copy=structuredClone(value);const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};return freeze(copy);}
function referencedFile(events,attachmentId){
  for(const event of events){const d=event.data;let contents=[];
    switch(event.type){
      case 'user/message':case 'tool/ptc-dispatch':contents=[d.content];break;
      case 'assistant/message':case 'system/message':case 'developer/message':case 'tool/result':case 'team/message/queued':contents=[d.message?.content];break;
      case 'agent/inbox/spliced':contents=(d.inserted??[]).map(m=>m.content);break;
      case 'compaction/summary':contents=[d.summary,d.rawOutput];break;
      default:continue;
    }
    for(const content of contents){if(!Array.isArray(content))continue;for(const block of content)if(block?.type==='file'&&block.attachment?.attachmentId===attachmentId)return structuredClone(block.attachment);}
  }
}
function address(p) {
  if (p.address !== undefined && p.sessionId !== undefined) fail('Use sessionId or address');
  if (p.address === undefined) return { kind: 'session', sessionId: id(p.sessionId) };
  const a = p.address;
  if (!a || typeof a !== 'object' || Array.isArray(a)) fail('Invalid address');
  if (a.kind === 'session') { params(a, ['kind', 'sessionId']); return { kind: 'session', sessionId: id(a.sessionId) }; }
  params(a, ['kind', 'parentSessionId', 'childSessionId', 'mode']);
  if (a.kind !== 'subagent' || !['one-shot', 'continuable', 'unknown'].includes(a.mode)) fail('Invalid subagent address');
  return { kind: a.kind, parentSessionId: id(a.parentSessionId), childSessionId: id(a.childSessionId), mode: a.mode };
}
function nativeError(error) {
  if (error instanceof LinkError) return error;
  const code = error?.code;
  if (typeof code === 'string' && /^(session\/|subagent\/|agent-preset\/|workspace\/|gateway\/bad-request$)/.test(code)) {
    return new LinkError(code, typeof error.message === 'string' ? error.message.slice(0, 1024) : 'DSH operation rejected');
  }
  if(error?.constructor?.name==='UserQuestionError'&&['BAD_ANSWER','REPLY_QUEUED','DELEGATED_CALLER','CALLER_NOT_LIVE'].includes(error.code))return new LinkError('QUESTION_'+error.code,'Question answer rejected');
  if(error?.constructor?.name==='WorkspaceActiveSessionError')return new LinkError('SESSION_ACTIVE','Stop session activity before archiving');
  if(error?.constructor?.name==='WorkspaceArchivedSessionPinError')return new LinkError('ARCHIVED_READ_ONLY','Restore explicitly before pinning');
  if(error?.constructor?.name==='WorkspaceUnknownSessionError')return new LinkError('session/not-found','Session not found');
  if(error?.constructor?.name==='WorkspaceMoveInvalidError')return new LinkError('WORKSPACE_MOVE_INVALID','Session and anchor must belong to the selected workspace');
  if (error?.constructor?.name === 'ApiSessionNotFound') return new LinkError('session/not-found', 'Session not found');
  if(error?.constructor?.name==='AttachmentError'&&['ATTACHMENT_NOT_FOUND','ATTACHMENT_READ_FAILED','ATTACHMENT_CORRUPT','INVALID_ATTACHMENT_REF','ATTACHMENT_FILES_UNSUPPORTED'].includes(code))return new LinkError(code,'File attachment read failed');
  if (error?.name === 'AbortError') return new LinkError('CANCELLED', 'Operation cancelled');
  return new LinkError('INTERNAL_ERROR', 'DSH operation failed');
}

/** Adapter for the host's existing SessionController; never parses JSONL itself. */
export class ChatBridge {
  constructor(ctx, link) {
    this.ctx = ctx; this.link = link; this.controller = ctx.sessionController;
    this.content = new ContentStore({ inlineBytes: Math.min(131072, Math.max(128, link.config.maxPayloadBytes - 8192)),
      chunkBytes: Math.min(49152, Math.max(1, Math.floor((link.config.maxPayloadBytes - 1024) * .7))) });
    this.subscriptions = new Map(); this.lists = new Map(); this.prompts = new Map(); this.uploads = new Map(); this.downloads = new Map(); this.approvals = new Map(); this.disposers = []; this.pumps = new Set();
    this.searchPager=new SearchPager(ctx,value=>this.content.pack(value));
    this.disposers.push(ctx.on('session/disposed',session=>{for(const entry of [...this.approvals.values()])if(entry.agent.session===session)this.closeApproval(entry);},{global:true}));
    this.onState = ({ state }) => { if (state !== 'ready') this.reset(); };
    link.on('state', this.onState);
    this.install();
    this.disposers.push(ctx.on('domain/changed',change=>{
      if(change.domain==='workspace')link.publish('session.list.changed',{change:'updated',reason:'workspace-state'});
    },{global:true}));
    // Native title events cover phone, desktop and automatic title producers.
    // Invalidate lists without changing existing stable pagination snapshots.
    this.disposers.push(ctx.on('session/event', (session, event) => {
      if (event.type === 'session/title') {
        link.publish('session.list.changed', { sessionId: session.id, change: 'updated', reason: 'title', seq: event.seq });
      }
    }, { global: true }));
    for (const [event, change] of Object.entries({ 'api-session/added': 'added', 'api-session/removed': 'removed',
      'api-session/status': 'status', 'api-session/activity': 'activity', 'api-session/error': 'error' })) {
      this.disposers.push(ctx.on(event, value => {
        const sessionId = typeof value === 'string' ? value : value.sessionId;
        link.publish('session.list.changed', { sessionId, change });
      }, { global: true }));
    }
  }
  register(name, handler) {
    this.disposers.push(this.link.registerMethod(name, async (p, request) => {
      request.signal.throwIfAborted();
      try { return await handler(p, request); } catch (error) { throw nativeError(error); }
    }));
  }
  reset() {
    for (const entry of this.subscriptions.values()) entry.controller.abort();
    for(const entry of [...this.approvals.values()])this.closeApproval(entry);this.approvals.clear();
    this.subscriptions.clear(); this.content.clear(); this.lists.clear();
    this.searchPager.clear();
    for (const entry of this.uploads.values()) entry.abort.abort(); this.uploads.clear();
    for(const entry of [...this.downloads.values()])this.closeDownload(entry);
  }
  async dispose() {
    const pumps = [...this.pumps];
    this.link.off('state', this.onState); this.reset();
    for (const dispose of this.disposers.reverse()) dispose();
    this.prompts.clear(); await Promise.allSettled(pumps);
  }
  async inspect(a, signal) {
    if (a.kind === 'subagent') await this.controller.page({ address: a, throughSeq: -1, maxMessages: 1 }, signal);
    const result = await this.controller.inspect(a.kind === 'session' ? a.sessionId : a.childSessionId, signal);
    if (a.kind === 'session' && result.meta.origin === 'subagent') throw new LinkError('SUBAGENT_ADDRESS_REQUIRED', 'Supply the subagent parent address');
    return result;
  }
  install() {
    const c = this.controller, pack = value => this.content.pack(value);
    const attachments=this.ctx.get('attachments');
    if(typeof attachments?.readFileStream==='function'){
      this.register('file.download.begin',async(p,r)=>{
        p=params(p,['sessionId','attachmentId']);const sessionId=id(p.sessionId),attachmentId=id(p.attachmentId,'attachmentId');
        if(!/^sha256:[a-f0-9]{64}$/.test(attachmentId))fail('Invalid file attachment identifier');
        const snapshot=await this.inspect({kind:'session',sessionId},r.signal);r.signal.throwIfAborted();
        const ref=referencedFile(snapshot.events,attachmentId);
        if(!ref)throw new LinkError('FILE_NOT_REFERENCED','File is not referenced by this Session');
        if(!Number.isSafeInteger(ref.bytes)||ref.bytes<0||ref.bytes>1073741824)throw new LinkError('FILE_SIZE_LIMIT','File exceeds 1 GiB download limit');
        if(typeof ref.name!=='string'||ref.name.length>255||/[\\/\0]/.test(ref.name)||['.','..'].includes(ref.name))throw new LinkError('INVALID_ATTACHMENT_REF','Invalid native file reference');
        if(this.downloads.size>=4)throw new LinkError('BUSY','Download slots full');
        const downloadId=randomUUID(),entry={downloadId,ref,offset:0,buffer:Buffer.alloc(0),hash:createHash('sha256'),abort:new AbortController(),chunkBytes:Math.max(1,Math.min(49152,Math.floor((this.link.config.maxPayloadBytes-2048)*.7)))};
        entry.iterator=attachments.readFileStream(ref,entry.abort.signal)[Symbol.asyncIterator]();
        this.downloads.set(downloadId,entry);this.touchDownload(entry);
        return {downloadId,file:ref,sha256:attachmentId.slice(7),chunkBytes:entry.chunkBytes,maxFileBytes:1073741824,expiresAt:entry.expiresAt};
      });
      this.register('file.download.read',async(p,r)=>{
        p=params(p,['downloadId','offset']);const downloadId=id(p.downloadId,'downloadId'),offset=integer(p.offset,'offset',0,1073741824,undefined),entry=this.downloads.get(downloadId);
        if(offset===undefined)fail('Missing offset');
        if(!entry||entry.expiresAt<=Date.now()){if(entry)this.closeDownload(entry);throw new LinkError('DOWNLOAD_EXPIRED','Download ended');}
        if(entry.busy)throw new LinkError('BUSY','A download read is pending');
        this.touchDownload(entry);
        if(entry.last?.offset===offset)return {...entry.last,expiresAt:entry.expiresAt};
        if(offset!==entry.offset)throw new LinkError('DOWNLOAD_OFFSET','Read nextOffset in order');
        if(entry.complete)return {downloadId,offset,data:'',nextOffset:offset,eof:true,verified:true,expiresAt:entry.expiresAt};
        entry.busy=true;const onAbort=()=>entry.abort.abort();r.signal.addEventListener('abort',onAbort,{once:true});
        try{
          r.signal.throwIfAborted();const chunks=[];let length=0;
          while(length<entry.chunkBytes&&entry.offset+length<entry.ref.bytes){
            if(!entry.buffer.length){const part=await entry.iterator.next();if(part.done)throw new LinkError('ATTACHMENT_CORRUPT','File ended before declared length');if(part.value.byteLength<1||part.value.byteLength>65536)throw new LinkError('RESOURCE_LIMIT','Unsupported backend chunk size');entry.buffer=Buffer.from(part.value);}
            const take=Math.min(entry.chunkBytes-length,entry.buffer.length,entry.ref.bytes-entry.offset-length);chunks.push(entry.buffer.subarray(0,take));entry.buffer=entry.buffer.subarray(take);length+=take;
          }
          const bytes=Buffer.concat(chunks,length);entry.hash.update(bytes);const nextOffset=entry.offset+length,eof=nextOffset===entry.ref.bytes;
          if(eof){if(entry.buffer.length||(await entry.iterator.next()).done!==true||entry.hash.digest('hex')!==entry.ref.attachmentId.slice(7))throw new LinkError('ATTACHMENT_CORRUPT','File integrity verification failed');entry.complete=true;}
          r.signal.throwIfAborted();if(!this.downloads.has(downloadId))throw new LinkError('DOWNLOAD_EXPIRED','Download was released');
          entry.offset=nextOffset;entry.last={downloadId,offset,data:bytes.toString('base64'),nextOffset,eof,verified:eof,expiresAt:entry.expiresAt};return entry.last;
        }catch(error){this.closeDownload(entry);throw error;}
        finally{entry.busy=false;r.signal.removeEventListener('abort',onAbort);}
      });
      this.register('file.download.release',p=>{p=params(p,['downloadId']);const entry=this.downloads.get(id(p.downloadId,'downloadId'));if(entry)this.closeDownload(entry);return {released:!!entry};});
    }
    this.register('content.read', p => { p = params(p, ['contentId', 'offset', 'length']); return this.content.read(text(p.contentId, 'contentId', 128), p.offset, p.length); });
    this.register('content.release', p => { p = params(p, ['contentId']); return { released: this.content.release(text(p.contentId, 'contentId', 128)) }; });
    this.register('session.list', async (p, r) => {
      p = params(p, ['limit', 'cursor','workspaceId','sort']); const limit = integer(p.limit, 'limit', 1, 100, 50);
      if(p.cursor!==undefined&&(p.workspaceId!==undefined||p.sort!==undefined))fail('Do not change list scope on continuation');
      if(p.sort!==undefined&&!['activity','manual'].includes(p.sort))fail('Invalid list sort');
      if(p.sort==='manual'&&p.workspaceId===undefined)fail('Manual order requires workspaceId');
      const now = Date.now(); for (const [key, entry] of this.lists) if (entry.expiresAt <= now) this.lists.delete(key);
      let entry, key, offset = 0;
      if (p.cursor !== undefined) {
        try {
          const cursor = JSON.parse(Buffer.from(text(p.cursor, 'cursor', 512), 'base64url').toString());
          key = cursor.id; offset = integer(cursor.offset, 'cursor offset', 0, Number.MAX_SAFE_INTEGER, undefined);
          if (typeof key !== 'string' || offset === undefined) fail('Invalid cursor');
        } catch { fail('Invalid cursor'); }
        entry = this.lists.get(key);
        if (!entry) throw new LinkError('CURSOR_EXPIRED', 'Repeat the initial list read');
        if (offset > entry.items.length) fail('Cursor past list end');
      } else {
        const result = await c.list({}, r.signal);
        // Detached snapshot preserves stable pagination during concurrent title/activity changes.
        const registry=this.ctx.get('workspaceRegistry'),pins=registry?.pinnedSessionIds??[],pinRanks=new Map(pins.map((value,index)=>[value,index]));
        const memberships=new Map();for(const workspace of registry?.list?.()??[])workspace.sessionIds.forEach((value,index)=>memberships.set(value,{workspaceId:workspace.id,workspaceOrder:index}));
        let workspace;if(p.workspaceId!==undefined){const workspaceId=id(p.workspaceId,'workspaceId');workspace=registry?.get?.(workspaceId);if(!workspace)throw new LinkError('WORKSPACE_NOT_FOUND','Workspace not found');}
        const items=result.items.filter(item=>item.origin!=='subagent'&&item.cwd&&!registry?.archivedSessionIds.includes(item.sessionId)&&(!workspace||workspace.sessionIds.includes(item.sessionId))).map(item=>({...item,pinned:pinRanks.has(item.sessionId),pinOrder:pinRanks.get(item.sessionId)??null,workspaceId:memberships.get(item.sessionId)?.workspaceId??null,workspaceOrder:memberships.get(item.sessionId)?.workspaceOrder??null}));
        items.sort((a,b)=>(a.pinned===b.pinned?0:a.pinned?-1:1)||(a.pinned?a.pinOrder-b.pinOrder:0)||(p.sort==='manual'?(a.workspaceOrder??Number.MAX_SAFE_INTEGER)-(b.workspaceOrder??Number.MAX_SAFE_INTEGER):0));
        const encoded = JSON.stringify(items);
        if (Buffer.byteLength(encoded) > 8388608) throw new LinkError('RESOURCE_LIMIT', 'Session list snapshot exceeds capacity');
        entry = { items: JSON.parse(encoded), expiresAt: now + 300000 }; key = randomUUID();
        while (this.lists.size >= 8) this.lists.delete(this.lists.keys().next().value);
        this.lists.set(key, entry);
      }
      const end = Math.min(offset + limit, entry.items.length), hasMore = end < entry.items.length;
      return pack({ items: entry.items.slice(offset, end), hasMore,
        nextCursor: hasMore ? Buffer.from(JSON.stringify({ id: key, offset: end })).toString('base64url') : null });
    });
    if(typeof this.ctx.get('sessionQuery')?.searchSessions==='function'&&this.ctx.get('sessionQuery').config?.openAt!=='never'){
      this.register('session.search',(p,r)=>this.searchPager.search(p,r));
      this.register('session.search.cancel',p=>this.searchPager.cancel(p));
    }
    const registry=this.ctx.get('workspaceRegistry');
    if(typeof registry?.pinSession==='function'&&typeof registry?.unpinSession==='function')this.register('session.pin',async(p,r)=>{
      p=params(p,['sessionId','pinned']);const sessionId=id(p.sessionId);if(typeof p.pinned!=='boolean')fail('pinned must be boolean');
      const source=await this.inspect({kind:'session',sessionId},r.signal);if(typeof source.meta.cwd!=='string'||!source.meta.cwd)throw new LinkError('WORKSPACE_SESSION_REQUIRED','Ordinary workspace session required');
      if(p.pinned)await registry.pinSession(sessionId);else await registry.unpinSession(sessionId);
      const pinOrder=registry.pinnedSessionIds.indexOf(sessionId);return {sessionId,pinned:pinOrder>=0,pinOrder:pinOrder>=0?pinOrder:null};
    });
    if(typeof registry?.list==='function'&&typeof registry?.get==='function'){
      this.register('workspace.list',async(p,r)=>{
        params(p,[]);const visible=new Set((await c.list({},r.signal)).items.filter(v=>v.origin!=='subagent'&&v.cwd).map(v=>v.sessionId)),archived=new Set(registry.archivedSessionIds);
        const items=registry.list().map(w=>({workspaceId:w.id,path:w.path,title:w.title,sessionIds:w.sessionIds.filter(value=>visible.has(value)&&!archived.has(value)),createdAt:w.createdAt,updatedAt:w.updatedAt}));
        if(Buffer.byteLength(JSON.stringify(items))>8388608)throw new LinkError('RESOURCE_LIMIT','Workspace snapshot exceeds capacity');
        return pack({items});
      });
      this.register('workspace.insertSessionBefore',async(p,r)=>{
        p=params(p,['workspaceId','sessionId','beforeSessionId']);const workspaceId=id(p.workspaceId,'workspaceId'),sessionId=id(p.sessionId),workspace=registry.get(workspaceId);
        if(!workspace)throw new LinkError('WORKSPACE_NOT_FOUND','Workspace not found');
        const ordinary=async value=>{const source=await this.inspect({kind:'session',sessionId:value},r.signal);if(!source.meta.cwd)throw new LinkError('WORKSPACE_SESSION_REQUIRED','Ordinary workspace session required');if(registry.archivedSessionIds.includes(value))throw new LinkError('ARCHIVED_READ_ONLY','Archived session cannot be reordered');};
        await ordinary(sessionId);const beforeSessionId=p.beforeSessionId===undefined?undefined:id(p.beforeSessionId,'beforeSessionId');if(beforeSessionId!==undefined)await ordinary(beforeSessionId);
        await workspace.insertSessionBefore(sessionId,beforeSessionId);
        const visible=new Set((await c.list({},r.signal)).items.filter(v=>v.origin!=='subagent'&&v.cwd&&!registry.archivedSessionIds.includes(v.sessionId)).map(v=>v.sessionId));
        return pack({workspace:{workspaceId:workspace.id,path:workspace.path,title:workspace.title,sessionIds:workspace.sessionIds.filter(value=>visible.has(value)),createdAt:workspace.createdAt,updatedAt:workspace.updatedAt}});
      });
    }
    if (registry?.archiveSession && registry?.unarchiveSession) {
      this.register('session.archive',async (p,r)=>{p=params(p,['sessionId']);const sessionId=id(p.sessionId);await this.inspect({kind:'session',sessionId},r.signal);await registry.archiveSession(sessionId);this.link.publish('session.list.changed',{sessionId,change:'removed'});return {archived:true,sessionId};});
      this.register('session.unarchive',async (p,r)=>{p=params(p,['sessionId']);const sessionId=id(p.sessionId);await this.inspect({kind:'session',sessionId},r.signal);await registry.unarchiveSession(sessionId);this.link.publish('session.list.changed',{sessionId,change:'added'});return {archived:false,sessionId};});
      this.register('session.archive.list',p=>{p=params(p,['offset','limit']);const offset=integer(p.offset,'offset',0,Number.MAX_SAFE_INTEGER,0),limit=integer(p.limit,'limit',1,100,30),ids=registry.archivedSessionIds;const nextOffset=Math.min(ids.length,offset+limit);return {sessionIds:ids.slice(offset,nextOffset),nextOffset,hasMore:nextOffset<ids.length};});
    }
    const files=this.ctx.get('fileUploads');
    if (files?.uploadStream) {
      this.register('file.upload.begin',async (p,r)=>{
        p=params(p,['sessionId','name','totalBytes','sha256']);const sessionId=id(p.sessionId),totalBytes=integer(p.totalBytes,'totalBytes',0,16777216);if(totalBytes===undefined||typeof p.sha256!=='string'||!/^[a-f0-9]{64}$/.test(p.sha256))fail('Invalid upload');
        const name=text(p.name,'name',255);if(/[\\/]/.test(name)||name==='.'||name==='..')fail('Display filename required');
        await this.inspect({kind:'session',sessionId},r.signal);this.pruneUploads();
        if(this.uploads.size>=4)throw new LinkError('RESOURCE_LIMIT','Four uploads maximum');
        const uploadId=randomUUID();this.uploads.set(uploadId,{sessionId,name,totalBytes,sha256:p.sha256,offset:0,chunks:[],hash:createHash('sha256'),expiresAt:Date.now()+300000,abort:new AbortController()});
        return {uploadId,chunkBytes:49152,maxFileBytes:16777216,expiresAt:this.uploads.get(uploadId).expiresAt};
      });
      this.register('file.upload.chunk',p=>{
        p=params(p,['uploadId','offset','data']);const e=this.uploadEntry(p),offset=integer(p.offset,'offset',0,16777216);if(typeof p.data!=='string'||p.data.length>65536||!p.data.length)fail('Invalid chunk');
        const bytes=Buffer.from(p.data,'base64');if(bytes.length>49152||bytes.toString('base64')!==p.data)fail('Canonical base64 required');
        if(e.promise)throw new LinkError('UPLOAD_COMMITTING','Upload already committing');
        if(offset<e.offset){const prior=e.chunks.find(c=>c.offset===offset);if(prior?.bytes.equals(bytes))return {uploadId:p.uploadId,nextOffset:e.offset};throw new LinkError('UPLOAD_OFFSET','Chunk conflict');}
        if(offset!==e.offset||e.offset+bytes.length>e.totalBytes)throw new LinkError('UPLOAD_OFFSET','Chunk offset or length mismatch');
        e.chunks.push({offset,bytes});e.hash.update(bytes);e.offset+=bytes.length;return {uploadId:p.uploadId,nextOffset:e.offset};
      });
      this.register('file.upload.commit',async (p,r)=>{
        p=params(p,['uploadId']);const e=this.uploadEntry(p);if(e.promise)return e.promise;
        if(e.offset!==e.totalBytes)throw new LinkError('UPLOAD_INCOMPLETE','Upload incomplete');
        if(e.hash.digest('hex')!==e.sha256){this.uploads.delete(p.uploadId);e.abort.abort();throw new LinkError('UPLOAD_HASH','Upload checksum mismatch');}
        const chunks=e.chunks;const signal=AbortSignal.any([r.signal,e.abort.signal]);
        e.promise=files.uploadStream({sessionId:e.sessionId,name:e.name,signal,data:(async function*(){for(const c of chunks){signal.throwIfAborted();yield c.bytes;}})()});
        try{return await e.promise;}finally{e.chunks=[];}
      });
      this.register('file.upload.abort',p=>{p=params(p,['uploadId']);const key=id(p.uploadId,'uploadId'),e=this.uploads.get(key);e?.abort.abort();this.uploads.delete(key);return {aborted:!!e};});
    }
    if(this.ctx.get('approval') && typeof c.resolveAgent==='function'){
      this.register('session.approval.subscribe',async(p,r)=>{
        p=params(p,['sessionId','subscriptionId']);const sessionId=id(p.sessionId),subscriptionId=id(p.subscriptionId,'subscriptionId');await this.inspect({kind:'session',sessionId},r.signal);
        if(this.approvals.size>=8||this.approvals.has(subscriptionId)||[...this.approvals.values()].some(e=>e.sessionId===sessionId))throw new LinkError('BUSY','Session already has an approval owner');
        const owner=await c.resolveAgent(sessionId);if(owner.error)throw owner.error;r.signal.throwIfAborted();
        // Recheck after asynchronous Agent resolution: exactly one phone can claim a Session.
        if(this.approvals.size>=8||this.approvals.has(subscriptionId)||[...this.approvals.values()].some(e=>e.sessionId===sessionId))throw new LinkError('BUSY','Session already has an approval owner');
        const entry={sessionId,subscriptionId,agent:owner.agent,pending:new Map()};
        entry.off=owner.agent.ctx.on('approval/request',(req,next)=>{
          if(req.agent!==entry.agent||!this.approvals.has(subscriptionId)||req.signal?.aborted||this.link.state!=='ready')return next();
          if(entry.pending.size>=16)return Promise.resolve('unavailable');
          return new Promise(resolve=>{
            const requestId=randomUUID(),item={requestId,toolName:req.toolName,...(req.callId?{callId:req.callId}:{}),...(req.reason?{reason:req.reason}:{})};
            if(Buffer.byteLength(JSON.stringify(item))>65536){resolve('unavailable');return;}
            const onAbort=()=>finish('cancelled');
            const finish=outcome=>{if(!entry.pending.delete(requestId))return;clearTimeout(timer);req.signal?.removeEventListener('abort',onAbort);resolve(outcome);this.link.publish('session.approval.end',{subscriptionId,requestId});};
            const timer=setTimeout(()=>finish('unavailable'),300000);timer.unref?.();
            entry.pending.set(requestId,{item,finish});req.signal?.addEventListener('abort',onAbort,{once:true});
            if(req.signal?.aborted){finish('cancelled');return;}
            this.link.publish('session.approval.request',{subscriptionId,request:pack(item)});
          });
        },{prepend:true});
        this.approvals.set(subscriptionId,entry);return {subscriptionId,sessionId};
      });
      this.register('session.approval.pending',p=>{p=params(p,['subscriptionId']);const entry=this.approvals.get(id(p.subscriptionId,'subscriptionId'));if(!entry)throw new LinkError('SUBSCRIPTION_NOT_FOUND','Approval subscription ended');return pack({requests:[...entry.pending.values()].map(v=>v.item)});});
      this.register('session.approval.decide',p=>{p=params(p,['subscriptionId','requestId','decision']);if(!['allowed-once','rejected'].includes(p.decision))fail('One-shot approval decision required');const entry=this.approvals.get(id(p.subscriptionId,'subscriptionId')),pending=entry?.pending.get(id(p.requestId,'requestId'));if(!pending)throw new LinkError('INTERACTION_ENDED','Approval request ended');pending.finish(p.decision);return {decided:true,requestId:p.requestId};});
      this.register('session.approval.unsubscribe',p=>{p=params(p,['subscriptionId']);const key=id(p.subscriptionId,'subscriptionId'),entry=this.approvals.get(key);if(entry)this.closeApproval(entry);return {unsubscribed:!!entry};});
    }
    const questions=this.ctx.get('userQuestions');
    if(questions?.answer&&typeof c.resolveAgent==='function')this.register('session.question.answer',async (p,r)=>{
      p=params(p,['sessionId','callId','answers']);const sessionId=id(p.sessionId),callId=id(p.callId,'callId');await this.inspect({kind:'session',sessionId},r.signal);
      if(!Array.isArray(p.answers)||p.answers.length<1||p.answers.length>32)fail('Invalid answers');
      const answers=p.answers.map(a=>{a=params(a,['id','selected','custom']);if(!Array.isArray(a.selected)||a.selected.length>64)fail('Invalid selected answers');return {id:text(a.id,'question id',128),selected:a.selected.map(v=>text(v,'option',4096)),...(a.custom===undefined?{}:{custom:text(a.custom,'custom',16384)})};});
      const view=await c.projections({sessionId},r.signal),question=view?.values?.userQuestions?.active?.find(q=>q.callId===callId);
      if(!question)return {answered:false};if(question.state!=='continued')throw new LinkError('QUESTION_OPEN','Foreground question has not continued');
      if(new Set(answers.map(a=>a.id)).size!==answers.length||answers.length!==question.questions.length)fail('Answer each question exactly once');
      for(const a of answers){const q=question.questions.find(q=>q.id===a.id);if(!q||(!q.multiSelect&&a.selected.length>1)||new Set(a.selected).size!==a.selected.length||a.selected.some(v=>!q.options?.some(o=>o.label===v)))fail('Invalid question answer');}
      const owner=await c.resolveAgent(sessionId);if(owner.error)throw owner.error;r.signal.throwIfAborted();
      return {answered:questions.answer(owner.agent,callId,{answers})};
    });
    this.register('session.get', async (p, r) => {
      p = params(p, ['sessionId', 'address']); const a = address(p), result = await this.inspect(a, r.signal);
      const sessionId = result.meta.id;
      return pack({ header: result.meta, cursor: result.events.at(-1)?.seq ?? -1,
        projections: await c.projections({ sessionId }, r.signal), running: this.ctx.get('agents')?.get(sessionId)?.status === 'running' });
    });
    this.register('session.page', async (p, r) => {
      p = params(p, ['sessionId', 'address', 'throughSeq', 'beforeSeq', 'maxMessages']); const a = address(p);
      const throughSeq = integer(p.throughSeq, 'throughSeq', -1, Number.MAX_SAFE_INTEGER,
        p.throughSeq === undefined ? (await this.inspect(a, r.signal)).events.at(-1)?.seq ?? -1 : undefined);
      const request = { address: a, throughSeq, maxMessages: integer(p.maxMessages, 'maxMessages', 1, 100, 50) };
      if (p.beforeSeq !== undefined) request.beforeSeq = integer(p.beforeSeq, 'beforeSeq', 0, Number.MAX_SAFE_INTEGER);
      const page = await c.page(request, r.signal);
      return pack({ ...page, throughSeq, nextBeforeSeq: page.hasMore ? page.records[0]?.event.seq ?? null : null });
    });
    // readSurface includes later replacements without transporting their entire raw history.
    if(typeof this.ctx.get('sessionQuery')?.readSurface==='function')this.register('session.context',async(p,r)=>{
      p=params(p,['sessionId','seq','throughSeq','before','after']);const sessionId=id(p.sessionId),seq=integer(p.seq,'seq',0,Number.MAX_SAFE_INTEGER);
      if(seq===undefined)fail('seq required');
      const before=integer(p.before,'before',0,25,8),after=integer(p.after,'after',0,25,8);
      const source=await this.inspect({kind:'session',sessionId},r.signal),latest=source.events.at(-1)?.seq??-1;
      if(typeof source.meta.cwd!=='string'||!source.meta.cwd)throw new LinkError('CONTEXT_SESSION_UNAVAILABLE','Ordinary workspace session required');
      const throughSeq=integer(p.throughSeq,'throughSeq',0,Number.MAX_SAFE_INTEGER,latest);
      if(throughSeq!==latest)throw new LinkError('CONTEXT_STALE','History changed; reopen context');
      const target=source.events[seq];if(!target||target.seq!==seq)throw new LinkError('EVENT_NOT_FOUND','Event not found');
      const surface=await this.ctx.get('sessionQuery').readSurface(sessionId,r.signal);r.signal.throwIfAborted();
      if(surface.session.id!==sessionId||surface.capturedThroughSeq!==throughSeq)throw new LinkError('CONTEXT_STALE','History changed during context read');
      const current=new Set(surface.events.map(e=>e.seq)),startSeq=Math.max(0,seq-before),endSeq=Math.min(throughSeq,seq+after);
      const matchCurrent=current.has(seq)&&['user/message','assistant/message'].includes(target.type);
      return pack({sessionId,throughSeq,target:{seq,type:target.type,current:current.has(seq),matchCurrent},status:matchCurrent?'current-match':'not-current-match',
        records:source.events.slice(startSeq,endSeq+1).map(event=>({type:'event',event,current:current.has(event.seq)})),startSeq,endSeq,
        hasBefore:startSeq>0,hasAfter:endSeq<throughSeq,previousSeq:startSeq>0?startSeq-1:null,nextSeq:endSeq<throughSeq?endSeq+1:null,
        coverage:{kind:'raw-event-window',surfaceVerifiedAt:throughSeq,completeHistory:startSeq===0&&endSeq===throughSeq,hostRead:'native-complete-log-and-current-surface',maxRecords:51}});
    });
    this.register('session.events', async (p, r) => {
      p = params(p, ['sessionId', 'address', 'afterSeq', 'throughSeq', 'limit']); const source = await this.inspect(address(p), r.signal);
      const latest = source.events.at(-1)?.seq ?? -1;
      const throughSeq = integer(p.throughSeq, 'throughSeq', -1, latest, latest);
      const afterSeq = integer(p.afterSeq, 'afterSeq', -1, Number.MAX_SAFE_INTEGER, -1);
      if (afterSeq > throughSeq) throw new LinkError('CURSOR_AHEAD', 'Cursor exceeds the requested log cut');
      const limit = integer(p.limit, 'limit', 1, 200, 100);
      const events = source.events.slice(afterSeq + 1, Math.min(throughSeq + 1, afterSeq + 1 + limit));
      const nextAfterSeq = events.at(-1)?.seq ?? afterSeq;
      return pack({ records: events.map(event => ({ type: 'event', event })), throughSeq, nextAfterSeq, hasMore: nextAfterSeq < throughSeq });
    });
    this.register('session.event', async (p, r) => {
      p = params(p, ['sessionId', 'address', 'seq']); const seq = integer(p.seq, 'seq', 0, Number.MAX_SAFE_INTEGER);
      if (seq === undefined) fail('seq required');
      const source = await this.inspect(address(p), r.signal), event = source.events[seq];
      if (!event || event.seq !== seq) throw new LinkError('EVENT_NOT_FOUND', 'Event not found');
      return pack({ type: 'event', event });
    });
    this.register('session.projections', async (p, r) => { p = params(p, ['sessionId']); return pack(await c.projections({ sessionId: id(p.sessionId) }, r.signal)); });
    this.register('session.attachment', async p => { p = params(p, ['sessionId', 'attachmentId']); return pack(await c.attachment({ sessionId: id(p.sessionId), attachmentId: id(p.attachmentId, 'attachmentId') })); });
    this.register('model.catalog', async p => { params(p, []); return pack(await c.modelCatalog()); });
    this.register('session.create', async p => {
      p = params(p, ['sessionId', 'cwd', 'workspaceId', 'agentPreset']); const request = {};
      if (p.cwd !== undefined && p.workspaceId !== undefined) fail('Use cwd or workspaceId');
      if (p.sessionId !== undefined) request.sessionId = id(p.sessionId);
      if (p.cwd !== undefined) request.cwd = text(p.cwd, 'cwd', 32768);
      if (p.workspaceId !== undefined) request.workspaceId = id(p.workspaceId, 'workspaceId');
      if (p.agentPreset !== undefined) request.agentPreset = text(p.agentPreset, 'agentPreset');
      return c.create(request);
    });
    this.register('session.rename', p => { p = params(p, ['sessionId', 'title']); return c.rename({ sessionId: id(p.sessionId), title: text(p.title, 'title', 4096) }); });
    this.register('session.fork', p => {
      p = params(p, ['sessionId', 'atSeq']); const request = { sessionId: id(p.sessionId) };
      if (p.atSeq !== undefined) request.atSeq = integer(p.atSeq, 'atSeq', 0, Number.MAX_SAFE_INTEGER);
      return c.fork(request);
    });
    this.register('session.selectModel', p => {
      p = params(p, ['sessionId', 'provider', 'model', 'reasoningEffort']);
      const request = { sessionId: id(p.sessionId), provider: text(p.provider, 'provider'), model: text(p.model, 'model') };
      if (p.reasoningEffort !== undefined) request.reasoningEffort = text(p.reasoningEffort, 'reasoningEffort');
      return c.selectModel(request);
    });
    this.register('session.prompt', (p, r) => this.prompt(p, r));
    if(typeof c.resolveAgent==='function'&&this.ctx.get('agents'))this.register('session.queue.editText',async(p,r)=>{
      p=params(p,['sessionId','itemId','text','expectedContentHash']);const sessionId=id(p.sessionId),itemId=id(p.itemId,'itemId');
      if(typeof p.text!=='string'||p.text.length>65536||p.text.includes('\0')||typeof p.expectedContentHash!=='string'||!/^[a-f0-9]{64}$/.test(p.expectedContentHash))fail('Invalid text edit');
      await this.inspect({kind:'session',sessionId},r.signal);const owner=await c.resolveAgent(sessionId);if(owner.error)throw owner.error;r.signal.throwIfAborted();
      const agent=owner.agent;if(this.ctx.get('agents').get(agent.id)!==agent)throw new LinkError('session/queue-item-not-found','Agent is no longer live');
      const message=agent.inbox.nextTurn.find(m=>m.id===itemId)??agent.inbox.nextStep.find(m=>m.id===itemId);
      if(!message)throw new LinkError('session/queue-item-not-found','Queued item is no longer pending');
      if(message.role!=='user'||message.source?.kind!=='user')throw new LinkError('QUEUE_NOT_EDITABLE','Only ordinary queued user input may be edited');
      if(contentHash(message.content)!==p.expectedContentHash)throw new LinkError('QUEUE_CONTENT_CHANGED','Refresh queued content before editing');
      if(message.content.some(b=>!['text','image','file'].includes(b.type)))throw new LinkError('QUEUE_NOT_EDITABLE','Unknown content cannot be safely edited');
      const content=[];let inserted=false;
      for(const block of message.content){if(block.type!=='text'){content.push(block);continue;}if(!inserted){if(p.text.trim())content.push({type:'text',text:p.text});inserted=true;}}
      if(!inserted&&p.text.trim())content.unshift({type:'text',text:p.text});
      if(!content.length)fail('Edited message cannot be empty');
      // No awaits between reading and replacing: native Inbox owns persistence and
      // keeps the original identity/source and already admitted attachment refs.
      if(!agent.inbox.replace(itemId,immutableCopy({...message,content})))throw new LinkError('session/queue-item-not-found','Queued item was consumed');
      return {accepted:true,itemId,contentHash:contentHash(content)};
    });
    this.register('session.cancel', p => { p = params(p, ['sessionId']); return c.cancel({ sessionId: id(p.sessionId) }); });
    this.register('session.queue.update', async (p,r) => {
      p = params(p, ['sessionId', 'itemId', 'action']); const action = params(p.action, ['kind', 'content']);
      if (!['edit', 'remove', 'steer'].includes(action.kind)) fail('Invalid queue action');
      const value = { kind: action.kind };
      if (action.kind === 'edit') value.content = this.parts(action.content, true);
      else if (action.content !== undefined) fail('content only valid for edit');
      if(action.kind==='edit'&&typeof c.resolveAgent==='function'){
        await this.inspect({kind:'session',sessionId:id(p.sessionId)},r.signal);const owner=await c.resolveAgent(p.sessionId);if(owner.error)throw owner.error;r.signal.throwIfAborted();
        const inbox=owner.agent.inbox,message=inbox?.nextTurn?.find(m=>m.id===p.itemId)??inbox?.nextStep?.find(m=>m.id===p.itemId);
        if(message?.content.some(b=>b.type!=='text'))throw new LinkError('QUEUE_ATTACHMENT_EDIT_REQUIRED','Use attachment-preserving queue.editText');
      }
      return c.updateQueue({ sessionId: id(p.sessionId), itemId: id(p.itemId, 'itemId'), action: value });
    });
    this.register('session.subscribe', (p, r) => this.subscribe(p, r));
    this.register('session.unsubscribe', p => {
      p = params(p, ['subscriptionId']); const key = id(p.subscriptionId, 'subscriptionId'), entry = this.subscriptions.get(key);
      if (entry) { this.subscriptions.delete(key); entry.controller.abort(); }
      return { unsubscribed: !!entry };
    });
  }
  closeApproval(entry){this.approvals.delete(entry.subscriptionId);entry.off?.();for(const p of [...entry.pending.values()])p.finish('unavailable');this.link.publish('session.subscription.end',{subscriptionId:entry.subscriptionId,error:{code:'APPROVAL_OWNER_ENDED'}});}
  touchDownload(entry){clearTimeout(entry.timer);entry.expiresAt=Date.now()+300000;entry.timer=setTimeout(()=>this.closeDownload(entry),300000);entry.timer.unref?.();}
  closeDownload(entry){this.downloads.delete(entry.downloadId);clearTimeout(entry.timer);entry.abort.abort();entry.buffer=Buffer.alloc(0);entry.last=undefined;Promise.resolve(entry.iterator.return?.()).catch(()=>{});}
  pruneUploads(){for(const [key,e] of this.uploads)if(e.expiresAt<=Date.now()){e.abort.abort();this.uploads.delete(key);}}
  uploadEntry(p){this.pruneUploads();const e=this.uploads.get(id(p.uploadId,'uploadId'));if(!e)throw new LinkError('UPLOAD_EXPIRED','Upload expired');return e;}
  parts(value, textOnly = false) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 256) fail('Invalid content parts');
    let meaningful = false;
    const parts = value.map(part => {
      if (part?.type === 'text') {
        params(part, ['type', 'text']); if (typeof part.text !== 'string') fail('Invalid text');
        meaningful ||= !!part.text.trim(); return { type: 'text', text: part.text };
      }
      if (textOnly) fail('Only text parts are supported for queue edits');
      if (part?.type === 'image') {
        params(part, ['type', 'mediaType', 'data', 'name']);
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mediaType)) fail('Invalid image mediaType');
        const image = { type: 'image', mediaType: part.mediaType, data: text(part.data, 'image data', 262144) };
        if (part.name !== undefined) image.name = text(part.name, 'image name'); meaningful = true; return image;
      }
      if (part?.type === 'file') { params(part, ['type', 'receiptId']); meaningful = true; return { type: 'file', receiptId: id(part.receiptId, 'receiptId') }; }
      fail('Unknown content part');
    });
    if (!meaningful) fail('Prompt content is empty'); return parts;
  }
  async prompt(input, request) {
    const p = params(input, ['sessionId', 'clientRequestId', 'content', 'mode', 'clientTimeZone']);
    const sessionId = id(p.sessionId), clientRequestId = id(p.clientRequestId, 'clientRequestId');
    const mode = p.mode ?? 'queue'; if (!['queue', 'steer'].includes(mode)) fail('Invalid prompt mode');
    const native = { sessionId, requestId: clientRequestId, content: this.parts(p.content), mode };
    if (p.clientTimeZone !== undefined) native.clientTimeZone = text(p.clientTimeZone, 'clientTimeZone', 128);
    const fingerprint = createHash('sha256').update(JSON.stringify(native)).digest('hex'), key = JSON.stringify([sessionId, clientRequestId]);
    const prior = this.prompts.get(key);
    if (prior && prior.fingerprint !== fingerprint) throw new LinkError('ID_CONFLICT', 'clientRequestId reused with different content');
    if (prior) { await prior.promise; return { accepted: true, clientRequestId }; }
    if (this.prompts.size >= 1024) {
      for (const [key, entry] of this.prompts) if (entry.done) { this.prompts.delete(key); break; }
      if (this.prompts.size >= 1024) throw new LinkError('BUSY', 'Prompt admissions full');
    }
    const entry = { fingerprint, done: false };
    entry.promise = Promise.resolve().then(() => {
      request.signal.throwIfAborted(); return this.controller.prompt(native, request.signal);
    });
    this.prompts.set(key, entry);
    try { await entry.promise; entry.done = true; return { accepted: true, clientRequestId }; }
    catch (error) { if (this.prompts.get(key) === entry) this.prompts.delete(key); throw error; }
  }
  async subscribe(input, request) {
    const p = params(input, ['subscriptionId', 'sessionId', 'address', 'afterSeq', 'maxMessages']);
    const key = id(p.subscriptionId, 'subscriptionId'), a = address(p);
    if(a.kind==='session'&&this.ctx.get('workspaceRegistry')?.archivedSessionIds.includes(a.sessionId))throw new LinkError('ARCHIVED_READ_ONLY','Use get/page/events/projections for archived history');
    if (this.subscriptions.has(key)) throw new LinkError('SUBSCRIPTION_EXISTS', 'Subscription ID already in use');
    if (this.subscriptions.size >= 32) throw new LinkError('BUSY', 'Subscription limit reached');
    const entry = { controller: new AbortController(), connectionId: this.link.connectionId };
    this.subscriptions.set(key, entry);
    const cancel = () => entry.controller.abort(); request.signal.addEventListener('abort', cancel, { once: true });
    try {
      request.signal.throwIfAborted();
      entry.iterator = this.controller.follow({ address: a, maxMessages: integer(p.maxMessages, 'maxMessages', 1, 100, 50), assistantStream: true }, entry.controller.signal)[Symbol.asyncIterator]();
      const first = await entry.iterator.next();
      if (first.done || first.value.type !== 'snapshot') throw new LinkError('INTERNAL_ERROR', 'Missing opening snapshot');
      entry.controller.signal.throwIfAborted(); request.signal.throwIfAborted();
      const snapshot = first.value;
      const afterSeq = integer(p.afterSeq, 'afterSeq', -1, Number.MAX_SAFE_INTEGER, undefined);
      if (afterSeq !== undefined && afterSeq > snapshot.cursor) throw new LinkError('CURSOR_AHEAD', 'Cursor exceeds current log');
      const result = { subscriptionId: key, opening: this.content.pack(snapshot),
        replay: afterSeq !== undefined && afterSeq < snapshot.cursor ? { afterSeq, throughSeq: snapshot.cursor } : null };
      entry.pump = new Promise(resolve => setImmediate(resolve)).then(() => this.pump(key, entry));
      this.pumps.add(entry.pump);
      entry.pump.then(() => this.pumps.delete(entry.pump), () => this.pumps.delete(entry.pump));
      return result;
    } catch (error) {
      entry.controller.abort(); if (this.subscriptions.get(key) === entry) this.subscriptions.delete(key);
      try { await entry.iterator?.return?.(); } catch {} throw error;
    } finally { request.signal.removeEventListener('abort', cancel); }
  }
  async pump(key, entry) {
    try {
      while (!entry.controller.signal.aborted) {
        const next = await entry.iterator.next(); if (next.done || entry.controller.signal.aborted) break;
        if (this.link.connectionId !== entry.connectionId || this.link.state !== 'ready') break;
        const sent = this.link.publish('session.follow', { subscriptionId: key, frame: this.content.pack(next.value) });
        if (!sent) break;
      }
      if (!entry.controller.signal.aborted && this.link.connectionId === entry.connectionId) this.link.publish('session.subscription.end', { subscriptionId: key });
    } catch (error) {
      if (!entry.controller.signal.aborted && this.link.connectionId === entry.connectionId) {
        const safe = nativeError(error); this.link.publish('session.subscription.end', { subscriptionId: key, error: { code: safe.code, message: safe.message } });
      }
    } finally {
      entry.controller.abort(); try { await entry.iterator.return?.(); } catch {}
      if (this.subscriptions.get(key) === entry) this.subscriptions.delete(key);
    }
  }
}
