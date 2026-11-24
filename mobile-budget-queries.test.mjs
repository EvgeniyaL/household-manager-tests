import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createApi} from './helpers/api.mjs';
import {migrateStorage,createOfflineRepository} from '../mobile/src/core/storage/repository.ts';
import {BudgetChangedError,LocalDataError} from '../mobile/src/core/api/errors.ts';
import {overlayReport} from '../mobile/src/features/transactions/pendingReports.ts';
function adapter(raw){const sql={execAsync:async s=>raw.exec(s),runAsync:async(s,...a)=>raw.prepare(s).run(...a),getFirstAsync:async(s,...a)=>raw.prepare(s).get(...a)??null,getAllAsync:async(s,...a)=>raw.prepare(s).all(...a)};return{...sql,withExclusiveTransactionAsync:async fn=>{raw.exec('BEGIN IMMEDIATE');try{await fn(sql);raw.exec('COMMIT');}catch(e){raw.exec('ROLLBACK');throw e;}}};}
test('normalized pages remain partial, revisions invalidate all scopes, and receipts clean only acknowledged rows',async()=>{
 const raw=new DatabaseSync(':memory:');try{
 await migrateStorage(adapter(raw));const repo=createOfflineRepository(adapter(raw)),ws={householdId:'h',version:'1',currency:'EUR',role:'Owner'};
 await repo.observeWorkspace('a',ws);const p={id:'one',amountMinor:100,category:'Groceries',occurredOn:'2026-11-01',authorName:'A'};
 await repo.enqueue('a','h','Expense',p);await repo.enqueue('a','h','Expense',{...p,id:'two'});assert.equal((await repo.rows('a'))[0].attempted,0);
 await repo.markAttempted('a','one');await repo.acknowledge('a','one');await repo.saveQuery('a',ws,'page:first',{items:[{id:'server'}],hasMore:true},false);
 assert.equal((await repo.readQuery('a',ws,'page:first')).complete,false);assert.equal((await repo.readQuery('a',ws,'page:first')).value.items[0].id,'server');
 await repo.saveQuery('a',ws,'report:category:2026-11',{},true,['one','two']);assert.deepEqual((await repo.rows('a')).map(r=>r.id),['two']);
 raw.exec('DELETE FROM cached_entries');await assert.rejects(repo.readQuery('a',ws,'page:first'),LocalDataError);
 const next={...ws,version:'2',currency:'USD'};await repo.observeWorkspace('a',next);assert.equal(await repo.readQuery('a',next,'report:category:2026-11'),undefined);await assert.rejects(repo.saveQuery('a',ws,'late',{},true),BudgetChangedError);await assert.rejects(repo.observeWorkspace('a',ws),BudgetChangedError);
 }finally{raw.close();}
});
test('report overlay includes never attempted rows and proven missing rows without counting accepted or ambiguous uploads',()=>{
 const source={month:'2026-11',view:'category',baseCurrency:'EUR',version:'1',incomeMinor:0,expensesMinor:500,balanceMinor:-500,categories:[{category:'Groceries',amountMinor:500,percentage:100}],members:[],trends:[],pending:{accepted:['accepted'],missing:['missing'],unresolved:['ambiguous']}};
 const row=(id,attempted,currency='EUR')=>({id,accountId:'a',householdId:'h',type:'Expense',attempted,payload:JSON.stringify({id,amountMinor:100,category:'Groceries',occurredOn:'2026-11-01',authorName:'A',currency})});
 const result=overlayReport(source,[row('new',0),row('missing',1),row('accepted',1),row('ambiguous',1),row('foreign',0,'USD')]);assert.equal(result.report.expensesMinor,700);assert.equal(result.included,2);assert.equal(result.excluded,2);assert.equal(source.expensesMinor,500);
});
test('lightweight bootstrap, full-history reports, facets and revision-guarded pagination agree',async()=>{
 const api=await createApi();try{await api.start();const owner=await(await api.call('auth/register',{email:'owner@example.com',password:'Family-budget-123!'})).json();const h=await(await api.call('households',{name:'Family'},owner.token)).json();
 const ids=[];for(let i=0;i<53;i++){const id=randomUUID();ids.push(id);const response=await api.call(`households/${h.id}/expenses`,{id,amountMinor:100,category:i%2?'Transport':'Groceries',occurredOn:'2026-11-01',authorName:'Owner'},owner.token);assert.equal(response.status,201,await response.clone().text());}
 const boot=await(await api.call('households/bootstrap',undefined,owner.token)).json();assert.equal(boot.household.budget.entries,undefined);const version=boot.household.version;assert.ok(BigInt(version)>=53n);
 const page=await(await api.call(`households/${h.id}/transactions?limit=50&version=${version}`,undefined,owner.token)).json();assert.equal(page.items.length,50);assert.equal(page.hasMore,true);
 const facetResponse=await api.call(`households/${h.id}/transaction-facets?version=${version}`,undefined,owner.token);assert.equal(facetResponse.status,200,await facetResponse.clone().text());const facets=await facetResponse.json();assert.equal(facets.categories.length,2);assert.equal(facets.members.length,1);
 const missing=randomUUID();for(const view of ['category','member','trends']){const response=await api.call(`households/${h.id}/reports/query`,{month:'2026-11',view,version,pendingIds:[ids[0],missing]},owner.token);assert.equal(response.status,200,await response.clone().text());const report=await response.json();assert.equal(report.expensesMinor,5300);assert.deepEqual(report.pending.accepted,[ids[0]]);assert.deepEqual(report.pending.missing,[missing]);if(view==='trends')assert.equal(report.trends.length,12);if(view==='member')assert.equal(report.members[0].amountMinor,5300);}
 const entry=page.items[0];assert.equal((await api.call(`households/${h.id}/transactions/${entry.id}/delete`,{revision:entry.revision},owner.token)).status,204);
 assert.equal((await api.call(`households/${h.id}/transactions?offset=50&version=${version}`,undefined,owner.token)).status,409);
 assert.equal((await api.call(`households/${h.id}/reports/query`,{month:'2026-11',version},owner.token)).status,409);
 const reconciled=await(await api.call(`households/${h.id}/reports/query`,{month:'2026-11',view:'reconcile',pendingIds:[entry.id]},owner.token)).json();assert.deepEqual(reconciled.pending.accepted,[entry.id]);

 const member=await(await api.call('auth/register',{email:'member@example.com',password:'Family-budget-123!'})).json();
 const invite=await(await api.call('households/current/invites',{},owner.token)).json();assert.equal((await api.call('invites/redeem',{code:invite.code},member.token)).status,200);
 for(const view of ['member','trends'])assert.equal((await api.call(`households/${h.id}/reports/query`,{month:'2026-11',view},member.token)).status,403);
 assert.equal((await api.call(`households/${h.id}/reports/query`,{month:'2026-11',view:'category'},member.token)).status,200);

 const historicId=randomUUID();assert.equal((await api.call(`households/${h.id}/expenses`,{id:historicId,amountMinor:250,category:'Health',occurredOn:'2025-01-01',authorName:'Former author'},member.token)).status,201);
 assert.equal((await api.call(`households/${h.id}/categories/archive`,{key:'Health',type:'Expense'},owner.token)).status,204);
 assert.equal((await api.call(`households/${h.id}/members/${member.user.id}/remove`,{},owner.token)).status,200);
 const historicFacets=await(await api.call(`households/${h.id}/transaction-facets`,undefined,owner.token)).json();assert.ok(historicFacets.categories.includes('Health'));assert.ok(historicFacets.members.some(m=>m.id===member.user.id&&m.name==='Former author'));
 const outsider=await(await api.call('auth/register',{email:'outsider@example.com',password:'Family-budget-123!'})).json();assert.equal((await api.call(`households/${h.id}/transaction-facets`,undefined,outsider.token)).status,403);
 }finally{await api.dispose();}
});
import {createBudgetReader} from '../mobile/src/features/household/budgetReader.ts';
import {createSessionStore} from '../mobile/src/core/session/sessionStore.ts';
import {ConnectionError,OfflineQueryError,SessionChangedError} from '../mobile/src/core/api/errors.ts';
test('feature reader keeps complete reports independent of partial pages and refuses unsaved offline scopes',async()=>{
 const raw=new DatabaseSync(':memory:');try{
 await migrateStorage(adapter(raw));const repo=createOfflineRepository(adapter(raw));let token=null,identity=null;
 const session=createSessionStore({token:async()=>token,identity:async()=>identity,write:async(t,u)=>{token=t;identity=JSON.stringify({token:t,user:u});},writeIdentity:async(t,u)=>{identity=JSON.stringify({token:t,user:u});},clear:async()=>{token=null;identity=null;}});await session.saveToken('token',{id:'a',email:'a@example.com'});
 let online=true;const report={month:'2026-11',view:'category',baseCurrency:'EUR',version:'1',incomeMinor:0,expensesMinor:5300,balanceMinor:-5300,categories:[{category:'Groceries',amountMinor:5300,percentage:100}],members:[],trends:[],pending:{accepted:[],missing:[],unresolved:[]},savedAt:new Date().toISOString()};
 const reader=createBudgetReader({session,repository:async()=>repo,get:async path=>{if(path==='households/bootstrap')return{household:{id:'h',name:'Home',version:'1',baseCurrency:'EUR',role:'Owner',budget:{id:'b'}}};if(!online)throw new ConnectionError();if(path.includes('facets'))return{version:'1',categories:['Groceries','Historic'],members:[{id:'former',name:'Former member'}]};return{items:[],offset:0,limit:50,hasMore:true,version:'1',baseCurrency:'EUR'};},query:async()=>{if(!online)throw new ConnectionError();return report;}});
 const meta=await reader.metadata('token');await reader.page(meta,{month:'2026-11',category:'',member:''},0,'token');assert.equal((await reader.report(meta,'2026-11','category','token')).report.expensesMinor,5300);
 online=false;assert.equal((await reader.page(meta,{month:'2026-11',category:'',member:''},0,'token')).facets.categories[1],'Historic');const saved=await reader.report(meta,'2026-11','category','token');assert.equal(saved.offline,true);assert.equal(saved.report.expensesMinor,5300);
 await assert.rejects(reader.report(meta,'2026-10','category','token'),OfflineQueryError);await assert.rejects(reader.page(meta,{month:'2026-11',category:'',member:''},50,'token'),OfflineQueryError);
 await session.saveToken('other',{id:'b',email:'b@example.com'});await assert.rejects(reader.report(meta,'2026-11','category','other'),SessionChangedError);
 }finally{raw.close();}
});
