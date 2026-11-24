import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSessionStore} from '../mobile/src/core/session/sessionStore.ts';
import {createApiClient} from '../mobile/src/core/api/client.ts';
import {createTransport} from '../mobile/src/core/api/transport.ts';
import {ApiError,ConnectionError,InvalidResponseError,LocalDataError,RequestCancelledError,RequestTimeoutError,SessionChangedError} from '../mobile/src/core/api/errors.ts';
import {setCategoryCatalog,getCategoryCatalog,catalogRevision} from '../mobile/src/features/categories/categoryCatalog.ts';
const userA={id:'account-a',email:'a@example.com'},userB={id:'account-b',email:'b@example.com'};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function setup(){
 const data={token:null,identity:null,failClear:false,failWrite:false};
 const store=createSessionStore({token:async()=>data.token,identity:async()=>data.identity,
 write:async(token,user)=>{if(data.failWrite)throw Error('disk');data.token=token;data.identity=user?JSON.stringify({token,user}):null;},
 writeIdentity:async(token,user)=>{data.identity=JSON.stringify({token,user});},clear:async()=>{if(data.failClear)throw Error('disk');data.token=null;data.identity=null;}});
 const writes=[],publishes=[];let cached;
 const cache={read:()=>cached,write:(account,path,value)=>writes.push({account,path,value}),decorate:(path,identity,value,offline)=>{publishes.push({identity,offline});return value;}};
 return{store,data,writes,publishes,cache,setCache:value=>{cached=value;}};
}
const noCleanup=async()=>{};
test('offline restoration uses verified cached identity after cleanup, without deleting credentials',async()=>{
 const h=setup();h.data.token='token-a';h.data.identity=JSON.stringify({token:'token-a',user:userA});
 const order=[];assert.equal(await h.store.readToken(),null,'background work is blocked before cleanup');
 const api=createApiClient(h.store,async()=>{order.push('request');throw new ConnectionError();},h.cache);
 await h.store.restore(token=>api('auth/me',undefined,token),async()=>{order.push('cleanup');});
 assert.deepEqual(order,['cleanup','request']);assert.equal(h.store.getSnapshot().status,'authenticated');assert.deepEqual(h.store.getSnapshot().user,userA);assert.equal(h.data.token,'token-a');assert.equal(h.publishes[0].offline,true);
});
test('failed restoration is retryable and preserves the token; actual 401 revokes it',async()=>{
 const h=setup();h.data.token='token-a';
 let api=createApiClient(h.store,async()=>{throw new ConnectionError();},h.cache);
 await h.store.restore(token=>api('auth/me',undefined,token),noCleanup);assert.equal(h.store.getSnapshot().status,'restorationFailed');assert.equal(h.data.token,'token-a');
 api=createApiClient(h.store,async()=>userA,h.cache);await h.store.restore(token=>api('auth/me',undefined,token),noCleanup);assert.equal(h.store.getSnapshot().status,'authenticated');
 api=createApiClient(h.store,async()=>{throw new ApiError('expired',401);},h.cache);await assert.rejects(api('households/current',undefined,'token-a'),ApiError);assert.equal(h.store.getSnapshot().status,'signedOut');assert.equal(await h.store.readToken(),null);
});
for(const response of ['success','401'])test(`late ${response} from account A cannot clear or publish into account B`,async()=>{
 const h=setup();await h.store.saveToken('token-a',userA);const started=deferred(),reply=deferred();
 const api=createApiClient(h.store,async()=>{started.resolve();return reply.promise;},h.cache);
 const request=api('auth/me',undefined,'token-a');await started.promise;await h.store.saveToken('token-b',userB);
 if(response==='401')reply.reject(new ApiError('expired',401));else reply.resolve(userA);
 await assert.rejects(request,SessionChangedError);assert.equal(await h.store.readToken(),'token-b');assert.deepEqual(h.store.getSnapshot().user,userB);assert.equal(h.writes.length,0);assert.equal(h.publishes.length,0);
});
test('restore results cannot replace logout or a newer login',async()=>{
 const h=setup();h.data.token='token-a';const reply=deferred();
 const restoration=h.store.restore(()=>reply.promise,noCleanup);await new Promise(resolve=>setImmediate(resolve));
 await h.store.saveToken('token-b',userB);reply.resolve(userA);await restoration;assert.deepEqual(h.store.getSnapshot().user,userB);
 const second=h.store.restore(async()=>{await h.store.clearToken();return userA;},noCleanup);await second;assert.equal(h.store.getSnapshot().status,'signedOut');
});
test('failed credential persistence or erasure immediately blocks in-memory access',async()=>{
 const h=setup();await h.store.saveToken('token-a',userA);h.data.failWrite=true;
 await assert.rejects(h.store.saveToken('token-b',userB));assert.equal(await h.store.readToken(),null);assert.equal(h.store.getSnapshot().status,'signedOut');
 h.data.failWrite=false;await h.store.saveToken('token-a',userA);h.data.failClear=true;await assert.rejects(h.store.clearToken());assert.equal(h.store.getSnapshot().user,null);assert.equal(await h.store.readToken(),null);
});
test('interrupted account cleanup blocks restoration and remains retryable',async()=>{
 const h=setup();let called=false;
 await h.store.restore(async()=>{called=true;return userA;},async()=>{await h.store.clearToken();throw Error('cleanup incomplete');});
 assert.equal(called,false);assert.equal(h.store.getSnapshot().status,'restorationFailed');assert.equal(h.store.getSnapshot().error,'cleanup incomplete');
 await h.store.restore(async()=>userA,noCleanup);assert.equal(h.store.getSnapshot().status,'signedOut');
});
test('caller cancellation before or during fetch never uses cached data',async()=>{
 const h=setup();await h.store.saveToken('token-a',userA);h.setCache(userA);const started=deferred();
 const transport=createTransport({baseUrl:'https://test',network:async()=>({isConnected:true}),fetch:async(url,options)=>{started.resolve();return new Promise((yes,no)=>options.signal.addEventListener('abort',()=>no(Error('aborted'))));}});
 const api=createApiClient(h.store,transport,h.cache);let controller=new AbortController();controller.abort();await assert.rejects(api('auth/me',undefined,'token-a',{signal:controller.signal}),RequestCancelledError);
 controller=new AbortController();const request=api('auth/me',undefined,'token-a',{signal:controller.signal});await started.promise;controller.abort();await assert.rejects(request,RequestCancelledError);assert.equal(h.publishes.length,0);assert.equal(await h.store.readToken(),'token-a');
});
test('timeouts remain distinct from caller cancellation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const started=deferred();
 const transport=createTransport({baseUrl:'https://test',network:async()=>({isConnected:true}),fetch:async(url,options)=>{started.resolve();return new Promise((yes,no)=>options.signal.addEventListener('abort',()=>no(Error('aborted'))));}});
 const result=transport('auth/me');await started.promise;const rejected=assert.rejects(result,RequestTimeoutError);t.mock.timers.tick(15000);await rejected;
});
test('malformed network responses and corrupt local records are not treated as offline success',async()=>{
 const h=setup();await h.store.saveToken('token-a',userA);h.setCache(userA);
 let api=createApiClient(h.store,async()=>({email:'missing identity'}),h.cache);await assert.rejects(api('auth/me',undefined,'token-a'),InvalidResponseError);assert.equal(h.publishes.length,0);
 api=createApiClient(h.store,async()=>{throw new ConnectionError();},h.cache);h.setCache({bad:true});await assert.rejects(api('households/current',undefined,'token-a'),LocalDataError);
 h.data.identity='{broken';await assert.rejects(api('auth/me',undefined,'token-a'),LocalDataError);
});
test('transport normalizes legacy validation and ProblemDetails without losing error codes',async()=>{
 const errors=[{message:'Full',code:'member_limit_reached'}, {errors:{amount:['Positive only']}}, {title:'Unavailable',detail:'Please retry'}];
 for(const [index,error] of errors.entries()){
 const transport=createTransport({baseUrl:'https://test',network:async()=>({isConnected:true}),fetch:async()=>new Response(JSON.stringify(error),{status:400})});
 await assert.rejects(transport('test'),e=>e instanceof ApiError&&e.message===['Full','Positive only','Please retry'][index]&&(index!==0||e.details.code==='member_limit_reached'));
 }
 const broken=createTransport({baseUrl:'https://test',network:async()=>({isConnected:true}),fetch:async()=>new Response('{broken',{status:200})});await assert.rejects(broken('auth/me'),InvalidResponseError);
});
test('forbidden and read-only errors never expire sessions or fall back to cache',async()=>{
 const h=setup();await h.store.saveToken('token-a',userA);h.setCache(userA);
 for(const status of [402,403,409,500]){
 const api=createApiClient(h.store,async()=>{throw new ApiError('denied',status);},h.cache);await assert.rejects(api('auth/me',undefined,'token-a'),ApiError);assert.equal(await h.store.readToken(),'token-a');
 } assert.equal(h.publishes.length,0);
});
test('catalog identity includes household scope even when values are identical',()=>{
 const categories=[{key:'Groceries',type:'Expense',name:null,colour:'#245C48',archived:false}];
 setCategoryCatalog(categories,'account-a:household-a');const before=catalogRevision();setCategoryCatalog(categories,'account-b:household-b');assert.ok(catalogRevision()>before);setCategoryCatalog([], '');assert.deepEqual(getCategoryCatalog(),[]);
});


test('online identity refresh repairs corrupt identity without discarding the valid credential',async()=>{
 const h=setup();h.data.token='token-a';h.data.identity='{broken';
 const api=createApiClient(h.store,async()=>userA,h.cache);
 await h.store.restore(token=>api('auth/me',undefined,token),noCleanup);
 assert.equal(h.store.getSnapshot().status,'authenticated');assert.deepEqual(await h.store.cachedUser('token-a'),userA);
});
test('a login queued during expired-token erasure survives the old 401 continuation',async()=>{
 const clearing=deferred(),finishClear=deferred();let token=null,identity=null;
 const store=createSessionStore({token:async()=>token,identity:async()=>identity,write:async(next,user)=>{token=next;identity=JSON.stringify({token,user});},writeIdentity:async()=>{},clear:async()=>{clearing.resolve();await finishClear.promise;token=null;identity=null;}});
 await store.saveToken('token-a',userA);const api=createApiClient(store,async()=>{throw new ApiError('expired',401);},{read:()=>undefined,write:()=>{},decorate:(path,user,data)=>data});
 const result=api('auth/me',undefined,'token-a');await clearing.promise;
 const login=store.saveToken('token-b',userB);finishClear.resolve();await login;await assert.rejects(result,SessionChangedError);assert.equal(await store.readToken(),'token-b');assert.deepEqual(store.getSnapshot().user,userB);
});


test('cancellation interrupts a native connectivity probe that has not returned',async()=>{
 const started=deferred();const transport=createTransport({baseUrl:'https://test',network:()=>{started.resolve();return new Promise(()=>{});},fetch:async()=>{throw Error('must not fetch');}});
 const controller=new AbortController();const pending=transport('auth/me',undefined,undefined,{signal:controller.signal});await started.promise;controller.abort();await assert.rejects(pending,RequestCancelledError);
});
test('adopting a token without an identity requires restoration instead of exposing authenticated routes',async()=>{
 const h=setup();await h.store.saveToken('token-a');assert.equal(h.store.getSnapshot().status,'restorationFailed');assert.equal(await h.store.readToken(),'token-a');
 const api=createApiClient(h.store,async()=>userA,h.cache);await h.store.restore(token=>api('auth/me',undefined,token),noCleanup);assert.equal(h.store.getSnapshot().status,'authenticated');
});


test('known-expired credentials cannot be restored offline after secure deletion fails',async()=>{
 const h=setup();await h.store.saveToken('token-a',userA);h.data.failClear=true;
 const api=createApiClient(h.store,async()=>{throw new ApiError('expired',401);},h.cache);await assert.rejects(api('auth/me',undefined,'token-a'),ApiError);
 let called=false;await h.store.restore(async()=>{called=true;return userA;},noCleanup);
 assert.equal(called,false);assert.equal(h.store.getSnapshot().status,'signedOut');assert.equal(await h.store.readToken(),null);
});
