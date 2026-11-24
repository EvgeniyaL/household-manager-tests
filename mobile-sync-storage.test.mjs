import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename,join,resolve,sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApi } from './helpers/api.mjs';
import { createApiClient } from '../mobile/src/core/api/client.ts';
import { createSessionStore } from '../mobile/src/core/session/sessionStore.ts';
import { createReadCoordinator } from '../mobile/src/core/sync/readCoordinator.ts';
import { createSyncLifecycle } from '../mobile/src/core/sync/lifecycle.ts';
import { RequestCancelledError, LocalDataError, SessionChangedError } from '../mobile/src/core/api/errors.ts';
import { migrateStorage,createOfflineRepository } from '../mobile/src/core/storage/repository.ts';
import { createAsyncUploader } from '../mobile/src/core/sync/uploader.ts';
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
export function sqlAdapter(raw) {
 const sql={execAsync:async s=>{raw.exec(s);},runAsync:async(s,...args)=>raw.prepare(s).run(...args),getFirstAsync:async(s,...args)=>raw.prepare(s).get(...args)??null,getAllAsync:async(s,...args)=>raw.prepare(s).all(...args)};
 return{...sql,withExclusiveTransactionAsync:async action=>{raw.exec('BEGIN IMMEDIATE');try{await action(sql);raw.exec('COMMIT');}catch(e){raw.exec('ROLLBACK');throw e;}}};
}
const payload=id=>({id,amountMinor:1234,category:'Groceries',occurredOn:'2026-11-01',note:'Offline',authorName:'Member',currency:'USD',estimatedRate:true,rateToken:'frozen-proof'});
test('shared reads deduplicate, retain other consumers on cancellation, and separate account keys',async()=>{
 const reads=createReadCoordinator(),reply=deferred();let calls=0,underlying;
 const load=signal=>{calls++;underlying=signal;return reply.promise;};
 const a=new AbortController(),b=new AbortController();const one=reads.read('account-a/current',load,a.signal),two=reads.read('account-a/current',load,b.signal);
 await turn();a.abort();await assert.rejects(one,RequestCancelledError);assert.equal(calls,1);assert.equal(underlying.aborted,false);reply.resolve('A');assert.equal(await two,'A');
 assert.equal(await reads.read('account-b/current',async()=> 'B'),'B');
});
test('last consumer cancellation aborts the loader and invalidation waits before a fresh read',async()=>{
 const reads=createReadCoordinator(),reply=deferred();let signal;
 const controller=new AbortController();const first=reads.read('current',s=>{signal=s;return reply.promise;},controller.signal);await turn();controller.abort();await assert.rejects(first,RequestCancelledError);assert.equal(signal.aborted,true);
 let newer=0;const second=reads.read('current',async()=>{newer++;return 'new';});await turn();assert.equal(newer,0);reply.resolve('old');assert.equal(await second,'new');
 const old=deferred();const third=reads.read('current',()=>old.promise);await turn();reads.invalidate();const fresh=reads.read('current',async()=> 'fresh');old.resolve('point-in-time');assert.equal(await third,'point-in-time');assert.equal(await fresh,'fresh');
});
test('one lifecycle timer coalesces foreground/reconnect events and does not poll hidden history',async()=>{
 let enabled=true,sets=0,clears=0,uploadCalls=0,visibleCalls=0,tick;const blocked=deferred();
 const runtime=createSyncLifecycle({enabled:()=>enabled,upload:async()=>{uploadCalls++;},timer:{set:fn=>{sets++;tick=fn;return 1;},clear:()=>{clears++;}}});
 const stopA=runtime.start(),stopB=runtime.start();const unwatch=runtime.watch(async()=>{visibleCalls++;if(visibleCalls===1)await blocked.promise;});
 await turn();for(let i=0;i<10;i++)runtime.pulse(true);await turn();assert.equal(visibleCalls,1);assert.equal(sets,1);blocked.resolve();await turn();await turn();assert.equal(visibleCalls,2);
 unwatch();const before=visibleCalls;tick();await turn();assert.equal(visibleCalls,before);assert.ok(uploadCalls>0);
 enabled=false;const uploaded=uploadCalls;runtime.pulse(true);await turn();assert.equal(uploadCalls,uploaded);stopA();stopA();assert.equal(clears,0);stopB();assert.equal(clears,1);
});
test('migration adopts unversioned records without changing payloads, and refuses newer schemas',async()=>{
 const raw=new DatabaseSync(':memory:'),db=sqlAdapter(raw);
 try{
 raw.exec('CREATE TABLE cache(accountId TEXT NOT NULL,path TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(accountId,path));CREATE TABLE outbox(id TEXT PRIMARY KEY,accountId TEXT NOT NULL,householdId TEXT NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,error TEXT)');
 const frozen=JSON.stringify(payload('one'));raw.prepare('INSERT INTO outbox VALUES (?,?,?,?,?,?)').run('one','a','h','Expense',frozen,'rejected');raw.prepare('INSERT INTO cache VALUES (?,?,?)').run('a','households/current','{"saved":true}');
 await migrateStorage(db);await migrateStorage(db);assert.equal(raw.prepare('PRAGMA user_version').get().user_version,2);assert.equal(raw.prepare('SELECT payload FROM outbox').get().payload,frozen);assert.equal(raw.prepare('SELECT error FROM outbox').get().error,'rejected');assert.equal(raw.prepare('SELECT json FROM cache').get().json,'{"saved":true}');
 raw.exec('PRAGMA user_version=3');await assert.rejects(migrateStorage(db),LocalDataError);assert.equal(raw.prepare('SELECT count(*) AS n FROM outbox').get().n,1);
 }finally{raw.close();}
});
test('failed migration rolls back schema changes and version while preserving existing records',async()=>{
 const raw=new DatabaseSync(':memory:'),base=sqlAdapter(raw);
 try{
 raw.exec('CREATE TABLE cache(accountId TEXT NOT NULL,path TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(accountId,path));CREATE TABLE outbox(id TEXT PRIMARY KEY,accountId TEXT NOT NULL,householdId TEXT NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,error TEXT)');raw.prepare('INSERT INTO cache VALUES (?,?,?)').run('a','key','{}');
 const failing={...base,withExclusiveTransactionAsync:action=>base.withExclusiveTransactionAsync(tx=>action({...tx,execAsync:async sql=>{await tx.execAsync(sql.split('PRAGMA user_version')[0]);throw Error('disk full');}}))};
 await assert.rejects(migrateStorage(failing),/disk full/);assert.equal(raw.prepare('PRAGMA user_version').get().user_version,0);assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'IX_outbox_%'").get().n,0);assert.equal(raw.prepare('SELECT count(*) AS n FROM cache').get().n,1);
 }finally{raw.close();}
});
test('async uploader pages frozen rows, retains transient failures, and isolates account acknowledgements',async()=>{
 const raw=new DatabaseSync(':memory:'),db=sqlAdapter(raw);try{
 await migrateStorage(db);const repo=createOfflineRepository(db);for(let i=0;i<123;i++)await repo.enqueue('a','h','Expense',payload('id-'+i));await repo.enqueue('b','h','Expense',payload('other'));
 await assert.rejects(repo.enqueue('a','h','Expense',{...payload('id-0'),amountMinor:999}),/different values/);
 let max=0;const original=repo.uploadPage;repo.uploadPage=async(...args)=>{const page=await original(...args);max=Math.max(max,page.length);return page;};
 const upload=createAsyncUploader(repo);await upload('a',async()=>{throw {status:402};},async()=>true);assert.equal((await repo.rows('a')).length,123);
 let calls=0;await Promise.all([upload('a',async row=>{calls++;assert.equal(JSON.parse(row.payload).rateToken,'frozen-proof');},async()=>true),upload('a',async()=>{throw Error('overlap');},async()=>true)]);
 assert.equal(calls,123);assert.equal(max,50);assert.equal((await repo.rows('a')).filter(r=>r.delivered===1).length,123);assert.equal((await repo.rows('b')).length,1);
 await upload('b',async()=>{throw Object.assign(Error('forbidden'),{status:403});},async()=>true);assert.equal((await repo.rows('b'))[0].error,'forbidden');assert.equal((await repo.pendingEntries('b','h'))[0].authorAccountId,'b');
 }finally{raw.close();}
});
test('privacy erasure fences queued cache writes, preserves another account queue, and is retryable',async()=>{
 const raw=new DatabaseSync(':memory:'),db=sqlAdapter(raw);try{
 await migrateStorage(db);const repo=createOfflineRepository(db);await repo.enqueue('a','h','Expense',payload('a'));await repo.enqueue('b','h','Expense',payload('b'));await repo.writeCache('b','snapshot',{author:'a'});
 const pending=repo.writeCache('a','late',{private:true});const erased=repo.eraseAccount('a');await Promise.all([pending,erased]);await repo.writeCache('a','after',{private:true});await repo.eraseAccount('a');
 assert.equal(raw.prepare('SELECT count(*) AS n FROM cache').get().n,0);assert.equal((await repo.rows('a')).length,0);assert.equal((await repo.rows('b')).length,1);
 }finally{raw.close();}
});


test('async queue survives process reopen and lost acknowledgements without recreating edited or deleted entries',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'kin-async-restart-'));const path=join(folder,'queue.db');const server=await createApi();let raw=new DatabaseSync(path);
 try{
 await server.start();const owner=await(await server.call('auth/register',{email:'owner@example.com',password:'Family-budget-123!'})).json();const house=await(await server.call('households',{name:'Family'},owner.token)).json();
 await migrateStorage(sqlAdapter(raw));let repo=createOfflineRepository(sqlAdapter(raw));let upload=createAsyncUploader(repo);
 for(const kind of ['Expense','Income']){
  const p={id:randomUUID(),amountMinor:1234,category:kind==='Income'?'Salary':'Groceries',occurredOn:'2026-11-01',note:'Frozen',authorName:'Owner'};
  const queued=repo.enqueue(owner.user.id,house.id,kind,p);p.amountMinor=9999;await queued;
  const send=async row=>{const response=await server.call(`households/${house.id}/${kind==='Income'?'incomes':'expenses'}`,JSON.parse(row.payload),owner.token);assert.ok(response.ok);return response.json();};
  await upload(owner.user.id,async row=>{await send(row);throw Error('ack lost');},async()=>true);
  let entries=(await(await server.call('households/current',undefined,owner.token)).json()).household.budget.entries;const saved=entries.find(e=>e.id===p.id);assert.equal(Math.abs(saved.amountMinor),1234);
  const route=`households/${house.id}/transactions/${p.id}`;
  if(kind==='Income')assert.equal((await server.call(`${route}/delete`,{revision:saved.revision},owner.token)).status,204);
  else assert.equal((await server.call(`${route}/edit`,{revision:saved.revision,amountMinor:2000,category:'Groceries',occurredOn:p.occurredOn,note:'Corrected'},owner.token)).status,200);
  raw.close();raw=new DatabaseSync(path);await migrateStorage(sqlAdapter(raw));repo=createOfflineRepository(sqlAdapter(raw));upload=createAsyncUploader(repo);
  assert.equal(JSON.parse((await repo.rows(owner.user.id))[0].payload).amountMinor,1234);await upload(owner.user.id,async row=>{await send(row);},async()=>true);assert.equal((await repo.rows(owner.user.id)).filter(r=>r.id===p.id)[0].delivered,1);const ws={householdId:house.id,version:'1',currency:'EUR',role:'Owner'};await repo.observeWorkspace(owner.user.id,ws);await repo.saveQuery(owner.user.id,ws,'report:reconcile:test',{},true,[p.id]);assert.equal((await repo.rows(owner.user.id)).length,0);
  entries=(await(await server.call('households/current',undefined,owner.token)).json()).household.budget.entries;
  if(kind==='Income')assert.equal(entries.some(e=>e.id===p.id),false);else assert.equal(entries.find(e=>e.id===p.id).amountMinor,-2000);
 }
 }finally{raw.close();await server.dispose();if(!resolve(folder).startsWith(resolve(tmpdir())+sep)||!basename(folder).startsWith('kin-async-restart-'))throw Error('Unexpected cleanup path');await rm(folder,{recursive:true,force:true});}
});


test('mutation invalidation cancels household reads without cancelling identity restoration',async()=>{
 const reads=createReadCoordinator(),me=deferred();let householdSignal,identitySignal;
 const key=JSON.stringify([1,'token','households/current']);const identity=reads.read(JSON.stringify([1,'token','auth/me']),signal=>{identitySignal=signal;return me.promise;});
 const household=reads.read(key,signal=>{householdSignal=signal;return new Promise((yes,no)=>signal.addEventListener('abort',()=>no(new RequestCancelledError())));});await turn();
 reads.reset(key=>JSON.parse(key)[2].startsWith('households/'));await assert.rejects(household,RequestCancelledError);assert.equal(householdSignal.aborted,true);assert.equal(identitySignal.aborted,false);me.resolve('user');assert.equal(await identity,'user');
});
for(const boundary of ['write','decorate'])test(`an account switch during asynchronous cache ${boundary} cannot publish the old identity`,async()=>{
 let token=null,identity=null;const entered=deferred(),release=deferred();let published=0;
 const store=createSessionStore({token:async()=>token,identity:async()=>identity,write:async(next,user)=>{token=next;identity=JSON.stringify({token,user});},writeIdentity:async(next,user)=>{identity=JSON.stringify({token:next,user});},clear:async()=>{token=null;identity=null;}});
 await store.saveToken('a',{id:'a',email:'a@example.com'});
 const api=createApiClient(store,async()=>({id:'a',email:'a@example.com'}),{read:()=>undefined,
  write:async(account)=>{assert.equal(account,'a');if(boundary==='write'){entered.resolve();await release.promise;}},
  decorate:async(path,user,value,offline,valid)=>{if(boundary==='decorate'){entered.resolve();await release.promise;}valid();published++;return value;}});
 const pending=api('auth/me',undefined,'a');await entered.promise;await store.saveToken('b',{id:'b',email:'b@example.com'});release.resolve();await assert.rejects(pending,SessionChangedError);assert.equal(published,0);assert.equal(await store.readToken(),'b');
});
