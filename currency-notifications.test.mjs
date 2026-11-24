import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from './helpers/api.mjs';
import { currencyNoticeText } from '../../household-manager-mobile/src/localization.ts';
import { currencyNotificationRoute } from '../../household-manager-mobile/src/features/currency/currencyNotices.ts';

async function fixture() {
  let fail=false; const pushes=[];
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url.startsWith('/rate/')) { const pair=req.url.split('?')[0].split('/').slice(-2).map(s=>s.toUpperCase());res.end(JSON.stringify({date:new Date().toISOString().slice(0,10),base:pair[0],quote:pair[1],rate:pair[0]==='EUR'?1.25:0.8}));return; }
    let raw='';for await(const chunk of req) raw+=chunk;
    const body=JSON.parse(raw);pushes.push(body);
    if(fail) {res.writeHead(503);res.end('{}');return;}
    res.end(JSON.stringify({data:body.to==='ExpoPushToken[dead]'?{status:'error',details:{error:'DeviceNotRegistered'}}:{status:'ok',id:randomUUID()}}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  return {pushes,fail:value=>fail=value,env:{ExchangeRates__BaseUrl:base+'/',Reminders__PushUrl:base+'/push',CurrencyNotifications__PollSeconds:'1'},close:()=>new Promise(r=>server.close(r))};
}
async function register(api,name) {return (await (await api.call('auth/register',{email:name+'@example.com',password:'Family-budget-123!'})).json());}
async function join(api,owner,member) {const invite=await (await api.call('households/current/invites',{},owner.token)).json();assert.equal((await api.call('invites/redeem',{code:invite.code},member.token)).status,200);}
async function preferences(api,actor,token,language='en') {assert.equal((await api.call('account/reminder-preferences',{language,pushToken:token,pushAllowed:!!token},actor.token)).status,204);}
async function command(api,owner,id,currency) {const quote=await (await api.call(`households/${id}/base-currency/quote?currency=${currency}`,undefined,owner.token)).json();const input={operationId:randomUUID(),quoteToken:quote.token};assert.equal((await api.call(`households/${id}/base-currency/confirm`,input,owner.token)).status,202);return input;}
async function wait(check) {for(let i=0;i<150;i++) {if(await check())return;await delay(100);}assert.fail('notification condition did not complete');}
const current=async(api,actor)=>(await (await api.call('households/current',undefined,actor.token)).json());

test('successful currency change notifies every non-owner in-app and only permitted devices by push, with durable per-device delivery and dismissal',async()=>{
 const f=await fixture(),api=await createApi({env:f.env});
 try {
  await api.start();const owner=await register(api,'owner'),a=await register(api,'a'),b=await register(api,'b'),c=await register(api,'c'),other=await register(api,'other');
  const family=await (await api.call('households',{name:'Family'},owner.token)).json();for(const m of [a,b,c])await join(api,owner,m);
  await preferences(api,owner,'ExpoPushToken[owner]');await preferences(api,a,'ExpoPushToken[a]');await preferences(api,b,null,'bg');await preferences(api,c,'ExpoPushToken[dead]','bg');
  const second=await (await api.call('auth/login',{email:'a@example.com',password:'Family-budget-123!'})).json();await preferences(api,second,'ExpoPushToken[a_second]');
  const cmd=await command(api,owner,family.id,'USD');assert.equal(api.query('SELECT count(*) n FROM CurrencyNotices')[0].n,0,'nothing is announced before job commit');
  await api.stop();await api.start({BaseCurrency__Enabled:'true',CurrencyNotifications__Enabled:'true'});
  await api.startReplica({CurrencyNotifications__Enabled:'true',Recurring__Enabled:'false'});
  await wait(()=>api.query("SELECT count(*) n FROM CurrencyPushDeliveries WHERE State!='Pending'")[0].n===3);
  assert.equal(f.pushes.length,3);assert.ok(f.pushes.every(p=>p.to!=='ExpoPushToken[owner]'));
  const en=f.pushes.find(p=>p.to==='ExpoPushToken[a]'),bg=f.pushes.find(p=>p.to==='ExpoPushToken[dead]');
  assert.match(en.body,/from EUR to USD/);assert.match(en.body,/1 EUR = 1.25 USD/);assert.equal(en.channelId,'household');assert.equal(en.data.kind,'base-currency-change');assert.equal(en.data.householdId,family.id);
  assert.match(bg.body,/от EUR на USD/);assert.match(bg.body,/1 EUR = 1,25 USD/);
  assert.equal(api.query("SELECT count(*) n FROM Sessions WHERE PushToken='ExpoPushToken[dead]'")[0].n,0);
  assert.equal((await current(api,owner)).currencyNotices.length,0);
  const aNotice=(await current(api,a)).currencyNotices[0],bNotice=(await current(api,b)).currencyNotices[0];assert.ok(aNotice&&bNotice);assert.equal((await current(api,c)).currencyNotices.length,1);
  assert.equal(en.body,currencyNoticeText(aNotice,'en'));assert.equal(bg.body,currencyNoticeText((await current(api,c)).currencyNotices[0],'bg'));
  assert.equal(en.data.noticeId,aNotice.id);assert.equal((await current(api,other)).currencyNotices.length,0);
  const dismiss=`households/${family.id}/currency-notices/${bNotice.id}/dismiss`;
  assert.equal((await api.call(dismiss,{})).status,401);assert.equal((await api.call(dismiss,{},owner.token)).status,403);assert.equal((await api.call(dismiss,{},a.token)).status,404);assert.equal((await api.call(dismiss,{},other.token)).status,403);
  api.execute("UPDATE HouseholdSubscriptions SET TrialEndsAt='2020-01-01T00:00:00+00:00'");
  assert.equal((await api.call(dismiss,{},b.token)).status,204);assert.equal((await api.call(dismiss,{},b.token)).status,204);assert.equal((await current(api,b)).currencyNotices.length,0);
  await api.stop();await api.start({CurrencyNotifications__Enabled:'true'});await delay(1200);
  assert.equal(f.pushes.length,3,'accepted pushes are not repeated after restart');assert.equal((await current(api,a)).currencyNotices[0].id,aNotice.id,'in-app notice persists independently of push');
  assert.equal((await api.call(`households/${family.id}/base-currency/confirm`,cmd,owner.token)).status,200);assert.equal(api.query('SELECT count(*) n FROM CurrencyNotices')[0].n,3);
  assert.deepEqual(api.query('PRAGMA foreign_key_check'),[]);
 }finally{await api.dispose();await f.close();}
});

test('push outage does not hide in-app notice; retries recover, and revoked consent keeps later changes in-app only',async()=>{
 const f=await fixture(),api=await createApi({env:f.env});
 try {
  await api.start();const owner=await register(api,'owner'),member=await register(api,'member');const family=await (await api.call('households',{name:'Family'},owner.token)).json();await join(api,owner,member);await preferences(api,member,'ExpoPushToken[member]');
  f.fail(true);await command(api,owner,family.id,'USD');await api.stop();await api.start({BaseCurrency__Enabled:'true',CurrencyNotifications__Enabled:'true'});
  await wait(()=>f.pushes.length>=1);assert.equal((await current(api,member)).currencyNotices.length,1);assert.equal(api.query('SELECT State FROM CurrencyPushDeliveries')[0].State,'Pending');
  f.fail(false);api.execute("UPDATE CurrencyPushDeliveries SET RetryAt='2000-01-01T00:00:00+00:00'");
  await wait(()=>api.query('SELECT State FROM CurrencyPushDeliveries')[0].State==='Accepted');assert.equal(f.pushes.length,2);assert.equal(f.pushes[0].data.noticeId,f.pushes[1].data.noticeId);
  await preferences(api,member,null);await command(api,owner,family.id,'EUR');await wait(async()=>(await current(api,member)).currencyNotices.length===2);await delay(1100);
  assert.equal(f.pushes.length,2);assert.equal(api.query('SELECT count(*) n FROM CurrencyPushDeliveries')[0].n,1,'no push queued without consent');
  const notices=(await current(api,member)).currencyNotices;assert.equal(notices[0].fromCurrency,'USD');assert.equal(notices[0].toCurrency,'EUR');assert.equal(notices[0].rate,'0.8');
 }finally{await api.dispose();await f.close();}
});

test('delivery rechecks membership and consent after queueing, and account deletion erases its notification rows',async()=>{
 const f=await fixture(),api=await createApi({env:f.env});
 try {
  await api.start();const owner=await register(api,'owner'),a=await register(api,'a'),b=await register(api,'b');const family=await (await api.call('households',{name:'Family'},owner.token)).json();for(const m of [a,b]){await join(api,owner,m);await preferences(api,m,`ExpoPushToken[${m.user.id}]`);}
  await command(api,owner,family.id,'USD');await api.stop();await api.start({BaseCurrency__Enabled:'true'});await wait(()=>api.query('SELECT count(*) n FROM CurrencyNotices')[0].n===2);
  await preferences(api,b,null);assert.equal((await api.call(`households/${family.id}/members/${a.user.id}/remove`,{},owner.token)).status,200);
  await api.stop();await api.start({CurrencyNotifications__Enabled:'true'});await wait(()=>api.query("SELECT count(*) n FROM CurrencyPushDeliveries WHERE State='Skipped'")[0].n===2);assert.equal(f.pushes.length,0);
  assert.equal((await current(api,a)).currencyNotices.length,0);assert.equal((await current(api,b)).currencyNotices.length,1);
  assert.equal((await api.call('account/delete',{password:'Family-budget-123!',accountId:b.user.id},b.token)).status,204);
  assert.equal(api.query('SELECT count(*) n FROM CurrencyNotices WHERE AccountId=?',b.user.id.toUpperCase())[0].n,0);assert.deepEqual(api.query('PRAGMA foreign_key_check'),[]);
 }finally{await api.dispose();await f.close();}
});

test('currency notification text and deep links are localized and restrict navigation to the home notice',()=>{
 const n={id:'notice',fromCurrency:'EUR',toCurrency:'USD',rate:'1.25',rateDate:'2026-11-17'};
 assert.equal(currencyNoticeText(n,'en'),'The household base currency changed from EUR to USD. Rate used: 1 EUR = 1.25 USD. Rate date: 11/17/2026.');
 assert.equal(currencyNoticeText(n,'bg'),'Основната валута на домакинството е променена от EUR на USD. Използван курс: 1 EUR = 1,25 USD. Дата на курса: 17.11.2026 г.');
 assert.equal(currencyNotificationRoute({kind:'base-currency-change',url:'household-manager-mobile://'}),'/');
 for(const data of [undefined,{}, {kind:'base-currency-change',url:'https://example.com'}, {url:'household-manager-mobile://'}]) assert.equal(currencyNotificationRoute(data),null);
});
