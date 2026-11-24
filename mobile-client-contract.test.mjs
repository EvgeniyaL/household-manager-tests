import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApi} from './helpers/api.mjs';
import {createSessionStore} from '../mobile/src/core/session/sessionStore.ts';
import {createApiClient} from '../mobile/src/core/api/client.ts';
import {createTransport} from '../mobile/src/core/api/transport.ts';
test('mobile request decoders accept live backend auth, household, transaction, recurring and billing contracts',async()=>{
 const server=await createApi();let token=null,identity=null;
 try{
 await server.start();
 const store=createSessionStore({token:async()=>token,identity:async()=>identity,write:async(next,user)=>{token=next;identity=JSON.stringify({token,user});},writeIdentity:async(next,user)=>{identity=JSON.stringify({token:next,user});},clear:async()=>{token=null;identity=null;}});
 const transport=createTransport({baseUrl:'https://local.test',network:async()=>({isConnected:true}),fetch:(url,options)=>server.call(new URL(url).pathname.slice(5)+new URL(url).search,options.body?JSON.parse(options.body):undefined,undefined,options.headers)});
 const api=createApiClient(store,transport,{read:()=>undefined,write:()=>{},decorate:(path,user,data)=>data});
 const session=await api('auth/register',{email:'owner@example.com',password:'Family-budget-123!'});await store.saveToken(session.token,session.user);
 assert.equal((await api('auth/me',undefined,token)).id,session.user.id);
 const household=await api('households',{name:'Contract family'},token);const path=`households/${household.id}`;
 assert.equal((await api('households/current',undefined,token)).household.id,household.id);
 assert.equal((await api('households/current/members',undefined,token)).members.length,1);
 assert.ok((await api(`${path}/expense-categories`,undefined,token)).includes('Groceries'));
 const entry=await api(`${path}/expenses`,{id:randomUUID(),amountMinor:1234,category:'Groceries',occurredOn:'2026-11-01',authorName:'Owner'},token);
 assert.equal((await api(`${path}/transactions/${entry.id}`,undefined,token)).entry.id,entry.id);
 assert.equal((await api(`${path}/transactions?month=2026-11`,undefined,token)).items.length,1);
 const rule=await api(`${path}/recurring`,{id:randomUUID(),amountMinor:500,currency:'EUR',type:'Expense',category:'Housing',frequency:'Monthly',startDate:'2096-01-01',dayOfMonth:1},token);
 assert.equal((await api(`${path}/recurring`,undefined,token))[0].rule.id,rule.rule.id);
 const stopped=await api(`${path}/recurring/${rule.rule.id}/change`,{operationId:randomUUID(),revision:rule.rule.revision,action:'stop'},token);assert.equal(stopped.rule.stopped,true);
 assert.equal((await api(`${path}/subscription`,undefined,token)).subscription.status,'Trial');
 assert.equal((await api('households/current/export',undefined,token)).budget.entries.length,1);
 await api('auth/logout',{},token);await store.clearToken();assert.equal(store.getSnapshot().status,'signedOut');
 }finally{await server.dispose();}
});
