import {randomUUID,createHash} from 'node:crypto';
import {LinkError} from './transport.js';

const reject=message=>{throw new LinkError('INVALID_PARAMS',message);};
const clip=(s,n)=>{let result='',count=0;for(const ch of String(s??'')){if(count++===n)break;result+=ch;}return result;};
function parameters(value,keys){if(!value||typeof value!=='object'||Array.isArray(value))reject('Object required');for(const k of Object.keys(value))if(!keys.includes(k))reject('Unknown search field');return value;}
function searchError(error,signal){
  if(error instanceof LinkError)return error;
  if(signal?.aborted)return new LinkError(signal.reason?.name==='TimeoutError'?'SEARCH_TIMEOUT':'CANCELLED','Search interrupted');
  const codes={SESSION_QUERY_SEARCH_DISABLED:'SEARCH_DISABLED',SESSION_QUERY_STALE_CURSOR:'SEARCH_CURSOR_STALE',SESSION_QUERY_INVALID_CURSOR:'SEARCH_CURSOR_INVALID',SESSION_QUERY_INVALID_QUERY:'INVALID_PARAMS',SESSION_QUERY_INVALID_LIMIT:'INVALID_PARAMS',SESSION_QUERY_INDEX_FAILED:'SEARCH_INDEX_FAILED',SESSION_QUERY_PERSISTENCE_FAILED:'SEARCH_PERSISTENCE_FAILED',SESSION_QUERY_ABORTED:'CANCELLED'};
  return new LinkError(codes[error?.code]??'SEARCH_FAILED','Native search unavailable');
}

/** Pages the native current-surface index. Never resumes Agents or scans paths. */
export class SearchPager{
  constructor(ctx,pack){this.ctx=ctx;this.pack=pack;this.entries=new Map();this.pending=0;this.families=new Set();}
  clear(){for(const family of this.families)family.abort.abort();for(const e of this.entries.values())clearTimeout(e.timer);this.entries.clear();this.families.clear();}
  reap(){for(const family of this.families)if(!family.inflight&&![...this.entries.values()].some(e=>e.family===family))this.families.delete(family);}
  prune(){for(const [key,e] of this.entries)if(e.expiresAt<=Date.now()){clearTimeout(e.timer);this.entries.delete(key);}this.reap();}
  remember(e){
    this.prune();if(this.entries.size>=16){const cached=[...this.entries].find(([,v])=>v.cached&&!v.busy);if(!cached)throw new LinkError('BUSY','Search cursor slots full');clearTimeout(cached[1].timer);this.entries.delete(cached[0]);}
    this.reap();const key=randomUUID();e.expiresAt=Date.now()+300000;e.timer=setTimeout(()=>{this.entries.delete(key);this.reap();},300000);e.timer.unref?.();this.entries.set(key,e);return key;
  }
  response(value){return {...this.pack(value),nextCursor:value.nextCursor,cursorExpiresAt:value.cursorExpiresAt,searchId:value.searchId};}
  cancel(value){const p=parameters(value,['cursor']);if(typeof p.cursor!=='string'||p.cursor.length>128)reject('Cursor required');const e=this.entries.get(p.cursor);if(!e)return {cancelled:false};e.family.abort.abort();for(const [key,v] of this.entries)if(v.family===e.family){clearTimeout(v.timer);this.entries.delete(key);}this.families.delete(e.family);return {cancelled:true};}
  async search(value,request){
    const p=parameters(value,['query','includeArchived','limit','cursor']);let e,sourceCursor;
    if(p.cursor!==undefined){
      if(Object.keys(p).length!==1||typeof p.cursor!=='string'||p.cursor.length>128)reject('Cursor request must not change query');
      this.prune();e=this.entries.get(p.cursor);if(!e)throw new LinkError('SEARCH_CURSOR_EXPIRED','Restart search');
      if(e.cached)return this.response(e.cached);
      if(e.busy)throw new LinkError('BUSY','Search page is pending');sourceCursor=p.cursor;
    }else{
      if(typeof p.query!=='string'||!p.query.trim()||p.query.length>4096||p.query.includes('\0'))reject('Query must contain 1..4096 characters');
      if(p.includeArchived!==undefined&&typeof p.includeArchived!=='boolean')reject('Invalid archive scope');
      const requested=p.limit??20;if(!Number.isSafeInteger(requested)||requested<1||requested>20)reject('Limit must be 1..20');
      const nativeMax=this.ctx.get('sessionQuery')?.config?.maxLimit,limit=Number.isSafeInteger(nativeMax)&&nativeMax>0?Math.min(requested,nativeMax):requested;
      e={family:{id:randomUUID(),abort:new AbortController(),query:p.query.trim(),includeArchived:p.includeArchived??false,limit},page:1};this.families.add(e.family);
    }
    if(this.pending>=4){if(!sourceCursor)this.families.delete(e.family);throw new LinkError('BUSY','Search concurrency limit');}
    this.pending++;e.family.inflight=(e.family.inflight??0)+1;e.busy=true;const signal=AbortSignal.any([request.signal,e.family.abort.signal,AbortSignal.timeout(8000)]);
    try{
      signal.throwIfAborted();const query=this.ctx.get('sessionQuery');
      if(typeof query?.searchSessions!=='function'||query.config?.openAt==='never')throw new LinkError('SEARCH_DISABLED','Index disabled');
      const listed=await this.ctx.sessionController.list({},signal);signal.throwIfAborted();
      const visible=new Map(listed.items.filter(v=>v.origin!=='subagent'&&typeof v.cwd==='string'&&v.cwd.length>0).map(v=>[v.sessionId,v]));
      const archived=new Set(this.ctx.get('workspaceRegistry')?.archivedSessionIds??[]);
      const scopeHash=createHash('sha256').update(JSON.stringify([...visible.keys()].sort().map(id=>[id,archived.has(id)]))).digest('hex');
      if(e.family.scopeHash&&e.family.scopeHash!==scopeHash)throw new LinkError('SEARCH_CURSOR_STALE','Session visibility or archive scope changed');
      e.family.scopeHash=scopeHash;
      const page=await query.searchSessions({query:e.family.query,limit:e.family.limit,eventFilters:[{kind:'type',values:['user/message','assistant/message']},{kind:'surface',values:['current']}],...(e.nativeCursor?{cursor:e.nativeCursor}:{})},{signal});signal.throwIfAborted();
      if(!Array.isArray(page.items)||page.items.length>e.family.limit)throw new LinkError('SEARCH_PROVIDER_INVALID','Invalid native page');
      const items=[];let filtered=0;
      for(const hit of page.items){
        const meta=visible.get(hit.header?.id),match=hit.bestMatch;
        if(!meta||(!e.family.includeArchived&&archived.has(meta.sessionId))){filtered++;continue;}
        if(match?.sessionId!==meta.sessionId||!Number.isSafeInteger(match.seq)||match.seq<0||match.surface!=='current'||!['user/message','assistant/message'].includes(match.type)||typeof match.snippet!=='string')throw new LinkError('SEARCH_PROVIDER_INVALID','Invalid native match');
        items.push({sessionId:meta.sessionId,title:clip(meta.projections?.values?.title??meta.projections?.title??meta.sessionId,512),cwd:clip(meta.cwd,4096),archived:archived.has(meta.sessionId),snippet:clip(match.snippet,240),match:{seq:match.seq,type:match.type,surface:'current',...(Number.isFinite(match.time)?{time:match.time}:{})}});
      }
      let nextCursor=null,cursorExpiresAt=null;
      if(page.nextCursor!==undefined){if(typeof page.nextCursor!=='string'||page.nextCursor===e.nativeCursor)throw new LinkError('SEARCH_PROVIDER_INVALID','Invalid native continuation');const next={family:e.family,page:e.page+1,nativeCursor:page.nextCursor};nextCursor=this.remember(next);cursorExpiresAt=next.expiresAt;}
      const result={searchId:e.family.id,items,hasMore:nextCursor!==null,nextCursor,cursorExpiresAt,status:nextCursor?'more':'complete',page:e.page,coverage:{backend:'native-index',surface:'current',eventTypes:['user/message','assistant/message'],ordinaryOnly:true,includeArchived:e.family.includeArchived,accessibleSessions:visible.size,providerCandidates:page.items.length,filteredCandidates:filtered,matchSelection:'one-best-event-per-session',moreMeans:'provider-candidates',fallbackScan:false},budget:{limit:e.family.limit,timeoutMs:8000}};
      if(sourceCursor)e.cached=result;else if(!nextCursor)this.families.delete(e.family);
      return this.response(result);
    }catch(error){const mapped=searchError(error,signal);if(sourceCursor)this.cancel({cursor:sourceCursor});else{e.family.abort.abort();this.families.delete(e.family);}throw mapped;}
    finally{e.busy=false;this.pending--;e.family.inflight--;this.reap();}
  }
}
