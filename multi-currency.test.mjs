import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApi } from './helpers/api.mjs';
import { convertedMinor, lastKnownQuote } from '../mobile/src/moneyConversion.ts';
import { monthlyBalance } from '../mobile/src/monthlyBalance.ts';
import { transactionCsv } from '../mobile/src/transactionCsv.ts';

async function fixture() {
  let rate=0.925, unavailable=false;
  const requests=[];
  const server=createServer((req,res)=>{
    const url=new URL(req.url,'http://fixture'); requests.push(url);
    if(unavailable) {res.writeHead(503).end();return;}
    const pair=url.pathname.split('/').slice(-2).map(v=>v.toUpperCase());
    const date=new Date(url.searchParams.get('date')+'T12:00:00Z');
    while([0,6].includes(date.getUTCDay()) || date.toISOString().slice(0,10)==='2024-03-29') date.setUTCDate(date.getUTCDate()-1);
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({date:date.toISOString().slice(0,10),base:pair[0],quote:pair[1],rate:pair[0]==='USD'?rate:1/rate}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {env:{ExchangeRates__BaseUrl:`http://127.0.0.1:${server.address().port}/`},requests,setRate:value=>rate=value,setUnavailable:value=>unavailable=value,close:()=>new Promise(r=>server.close(r))};
}
async function setup(api,baseCurrency='EUR') {
  await api.start();
  const reg=async name=>(await (await api.call('auth/register',{email:`${name}@example.com`,password:'Family-budget-123!'})).json());
  const owner=await reg('owner'),member=await reg('member'),outsider=await reg('outsider');
  const household=await (await api.call('households',{name:'Family',baseCurrency},owner.token)).json();
  const invite=await (await api.call('households/current/invites',{},owner.token)).json();await api.call('invites/redeem',{code:invite.code},member.token);
  return {owner,member,outsider,household,route:`households/${household.id}`};
}
const input=()=>({id:randomUUID(),amountMinor:5000,currency:'USD',category:'Groceries',occurredOn:'2024-03-30',authorName:'Member',note:'Abroad'});

test('USD expenses and income snapshot dated ECB conversion, holiday fallback, totals, export and retry durability',async()=>{
  const f=await fixture(),api=await createApi({env:f.env});
  try {
    const {owner,member,outsider,route}=await setup(api);
    const p=input();
    assert.equal((await api.call(`${route}/expenses`,p,outsider.token)).status,403);
    const created=await api.call(`${route}/expenses`,p,member.token);assert.equal(created.status,201);const entry=await created.json();
    assert.equal(entry.originalAmountMinor,5000);assert.equal(entry.originalCurrency,'USD');assert.equal(entry.amountMinor,-4625);assert.equal(entry.exchangeRate,0.925);assert.equal(entry.rateDate,'2024-03-28');assert.equal(entry.estimatedRate,false);
    const requests=f.requests.length;f.setUnavailable(true);
    const replay=await api.call(`${route}/expenses`,p,member.token);assert.equal(replay.status,200);assert.deepEqual(await replay.json(),entry);assert.equal(f.requests.length,requests,'retries acknowledge the stored receipt without requiring rates');
    assert.equal((await api.call(`${route}/expenses`,{...p,currency:'EUR'},member.token)).status,409);
    f.setUnavailable(false);f.setRate(0.95);
    const income=await api.call(`${route}/incomes`,{...input(),category:'Salary',occurredOn:'2024-04-02'},member.token);assert.equal(income.status,201);
    const current=await (await api.call('households/current',undefined,owner.token)).json();
    assert.equal(current.household.budget.entries.find(e=>e.id===entry.id).amountMinor,-4625,'later rates never rewrite a saved conversion');
    assert.equal(monthlyBalance(current.household.budget.entries,'2024-03'),-4625);
    assert.equal(monthlyBalance(current.household.budget.entries,'2024-04'),4750);
    assert.ok(transactionCsv(current.household.budget.entries,'2024-03','EUR',k=>k).csv.includes('"50.00","USD","0.925"'));
    await api.stop();await api.start();
    assert.equal((await (await api.call(`${route}/transactions/${entry.id}`,undefined,member.token)).json()).entry.exchangeRate,0.925);
    assert.deepEqual(api.query('PRAGMA foreign_key_check'),[]);
  } finally {await api.dispose();await f.close();}
});

test('signed offline quotes retain estimates after sync, reject tampering and wrong households, and edit original money consistently',async()=>{
  const f=await fixture(),api=await createApi({env:f.env});
  try {
    const {owner,member,outsider,route}=await setup(api);
    const quote=await (await api.call(`${route}/exchange-rate?currency=USD&date=2024-03-28`,undefined,member.token)).json();assert.equal(quote.rate,'0.925');
    const p={...input(),estimatedRate:true,rateToken:quote.token};
    f.setUnavailable(true);
    const saved=await api.call(`${route}/expenses`,p,member.token);assert.equal(saved.status,201);let entry=await saved.json();assert.equal(entry.estimatedRate,true);assert.equal(entry.amountMinor,-4625);
    const bad=await api.call(`${route}/expenses`,{...p,id:randomUUID(),rateToken:'tampered'},member.token);assert.equal(bad.status,400);
    assert.equal((await api.call(`${route}/expenses`,{...p,id:randomUUID(),occurredOn:'2024-03-27'},member.token)).status,400,'no rate from a later publication');
    const other=await (await api.call('households',{name:'Other'},outsider.token)).json();
    assert.equal((await api.call(`households/${other.id}/expenses`,{...p,id:randomUUID()},outsider.token)).status,400);
    const edit={revision:entry.revision,amountMinor:6000,category:p.category,occurredOn:p.occurredOn,note:'Corrected in USD'};
    const changed=await api.call(`${route}/transactions/${entry.id}/edit`,edit,owner.token);assert.equal(changed.status,200);entry=await changed.json();
    assert.equal(entry.amountMinor,-5550);assert.equal(entry.originalAmountMinor,6000);assert.equal(entry.exchangeRate,0.925);assert.equal(entry.estimatedRate,true);assert.equal(entry.authorAccountId,member.user.id);
    f.setUnavailable(false);f.setRate(0.95);
    const changedDate=await api.call(`${route}/transactions/${entry.id}/edit`,{...edit,revision:entry.revision,occurredOn:'2024-04-02'},owner.token);assert.equal(changedDate.status,200);entry=await changedDate.json();assert.equal(entry.amountMinor,-5700);assert.equal(entry.exchangeRate,0.95);assert.equal(entry.estimatedRate,false);
    const same=await api.call(`${route}/expenses`,{...input(),currency:'EUR'},member.token);assert.equal(same.status,201);assert.equal((await same.json()).exchangeRate,1);
    assert.equal((await api.call(`${route}/expenses`,{...input(),currency:'GBP'},member.token)).status,400);
  } finally {await api.dispose();await f.close();}
});

test('EUR to USD conversion and decimal half-cent rounding use the original currency',async()=>{
  const f=await fixture(),api=await createApi({env:f.env});
  try {const {member,route}=await setup(api,'USD');f.setRate(0.8);
    const r=await api.call(`${route}/expenses`,{...input(),currency:'EUR',amountMinor:101},member.token);assert.equal(r.status,201);const entry=await r.json();assert.equal(entry.amountMinor,-126);assert.equal(entry.originalCurrency,'EUR');assert.equal(entry.exchangeRate,1.25);
  } finally {await api.dispose();await f.close();}
  assert.equal(convertedMinor(100,'0.145'),15);assert.equal(convertedMinor(101,'0.925'),93);assert.throws(()=>convertedMinor(1,'0.001'));
  const q={fromCurrency:'USD',toCurrency:'EUR',rate:'0.925',publishedDate:'2024-03-28',requestedOn:'2024-03-30',token:'proof',source:'ECB'};
  assert.equal(lastKnownQuote([q],'USD','EUR','2024-03-30'),q);assert.equal(lastKnownQuote([q],'USD','EUR','2024-03-27'),undefined);assert.equal(lastKnownQuote([q],'EUR','USD','2024-03-30'),undefined);
});


test('migration snapshots existing manual money in the household base currency without changing totals',async()=>{
  const api=await createApi();
  try {
    const {member,route}=await setup(api,'USD');
    const payload={...input(),currency:'USD'};
    const created=await api.call(`${route}/expenses`,payload,member.token);assert.equal(created.status,201);
    await api.stop();
    api.execute('UPDATE Entries SET OriginalAmountMinor=NULL,OriginalCurrency=NULL,ExchangeRate=NULL,RateDate=NULL,RateSource=NULL');
    api.execute('ALTER TABLE Entries DROP COLUMN EstimatedRate');
    api.execute('DROP TABLE ManualRates');
    api.execute("DELETE FROM __EFMigrationsHistory WHERE MigrationId LIKE '%_ManualCurrencySnapshots'");
    await api.start();
    const {entry:detail}=await (await api.call(`${route}/transactions/${payload.id}`,undefined,member.token)).json();
    assert.equal(detail.amountMinor,-5000);assert.equal(detail.originalAmountMinor,5000);assert.equal(detail.originalCurrency,'USD');assert.equal(detail.exchangeRate,1);assert.equal(detail.estimatedRate,false);
    assert.equal(detail.rateDate,payload.occurredOn);assert.equal(detail.rateSource,'Same currency');
  } finally {await api.dispose();}
});


test('authors override foreign rates with durable manual attribution, shared totals, validation and owner permissions',async()=>{
  const f=await fixture(),api=await createApi({env:f.env});
  try {
    const {owner,member,outsider,route}=await setup(api);
    const quote=await (await api.call(`${route}/exchange-rate?currency=USD&date=2024-03-30`,undefined,member.token)).json();
    let entry=await (await api.call(`${route}/expenses`,{...input(),estimatedRate:true,rateToken:quote.token},member.token)).json();
    const path=`${route}/transactions/${entry.id}/edit`;
    const edit={revision:entry.revision,amountMinor:5000,category:'Groceries',occurredOn:'2024-03-30',note:'Actual card charge',exchangeRate:0.9};
    assert.equal((await api.call(path,edit,outsider.token)).status,403);
    for(const exchangeRate of [0,-1,1001,0.1234567890123]) assert.equal((await api.call(path,{...edit,exchangeRate},member.token)).status,400);
    f.setUnavailable(true);
    const response=await api.call(path,edit,member.token);assert.equal(response.status,200);entry=await response.json();
    assert.equal(entry.amountMinor,-4500);assert.equal(entry.exchangeRate,0.9);assert.equal(entry.rateSource,'Manual rate');assert.equal(entry.estimatedRate,false);assert.equal(entry.originalAmountMinor,5000);assert.equal(entry.authorAccountId,member.user.id);
    assert.equal((await api.call(path,edit,member.token)).status,200,'lost response retry succeeds');
    const state=await (await api.call('households/current',undefined,owner.token)).json();
    assert.equal(monthlyBalance(state.household.budget.entries,'2024-03'),-4500);
    assert.ok(transactionCsv(state.household.budget.entries,'2024-03','EUR',k=>k).csv.includes('"Manual rate"'));
    // A new rate that rounds to the same cent still updates provenance/revision.
    const newer=await api.call(path,{...edit,revision:entry.revision,exchangeRate:0.900001},owner.token);assert.equal(newer.status,200);const changed=await newer.json();assert.equal(changed.amountMinor,-4500);assert.notEqual(changed.revision,entry.revision);assert.equal(changed.authorAccountId,member.user.id);
    assert.equal((await api.call(path,{...edit,revision:entry.revision,exchangeRate:0.91},member.token)).status,409);
    const corrected=await api.call(path,{...edit,revision:changed.revision,occurredOn:'2024-04-02',exchangeRate:undefined},member.token);assert.equal(corrected.status,200);entry=await corrected.json();assert.equal(entry.exchangeRate,0.900001);assert.equal(entry.rateSource,'Manual rate');
    const ownBase=await (await api.call(`${route}/expenses`,{...input(),currency:'EUR'},member.token)).json();
    assert.equal((await api.call(`${route}/transactions/${ownBase.id}/edit`,{...edit,revision:ownBase.revision},member.token)).status,400);
    f.setUnavailable(false);
    const income=await (await api.call(`${route}/incomes`,{...input(),category:'Salary'},member.token)).json();
    assert.equal((await api.call(`${route}/transactions/${income.id}/edit`,{...edit,revision:income.revision,category:'Salary',exchangeRate:0.8},member.token)).status,200);
    // The owner may correct members' entries; a regular member cannot correct the owner's.
    const owners=await (await api.call(`${route}/expenses`,input(),owner.token)).json();
    assert.equal((await api.call(`${route}/transactions/${owners.id}/edit`,{...edit,revision:owners.revision},member.token)).status,403);
    await api.stop();await api.start();
    const detail=await (await api.call(`${route}/transactions/${entry.id}`,undefined,member.token)).json();assert.equal(detail.entry.rateSource,'Manual rate');assert.equal(detail.entry.exchangeRate,0.900001);
    api.execute("UPDATE HouseholdSubscriptions SET TrialEndsAt='2020-01-01T00:00:00+00:00'");
    assert.equal((await api.call(path,{...edit,revision:detail.entry.revision,occurredOn:detail.entry.occurredOn,exchangeRate:0.85},member.token)).status,402);
  } finally {await api.dispose();await f.close();}
});


test('base-currency preview is owner-only and fetches a fresh ECB rate on every request',async()=>{
  const f=await fixture(),api=await createApi({env:f.env});
  try {
    const {owner,member,outsider,route}=await setup(api);
    const path=`${route}/base-currency/quote?currency=USD`;
    assert.equal((await api.call(path)).status,401);
    for(const actor of [member,outsider]) assert.equal((await api.call(path,undefined,actor.token)).status,403);
    for(const currency of ['EUR','GBP']) assert.equal((await api.call(`${route}/base-currency/quote?currency=${currency}`,undefined,owner.token)).status,400);
    f.setRate(0.8);
    const first=await api.call(path,undefined,owner.token);assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'no-store');
    const quote=await first.json();assert.equal(quote.fromCurrency,'EUR');assert.equal(quote.toCurrency,'USD');assert.equal(quote.rate,'1.25');assert.ok(quote.publishedDate<=new Date().toISOString().slice(0,10));
    f.setRate(0.5);
    assert.equal((await (await api.call(path,undefined,owner.token)).json()).rate,'2','latest provider quote replaces a prior preview');
    f.setUnavailable(true);assert.equal((await api.call(path,undefined,owner.token)).status,503,'never silently confirm a stale quote');
    const current=await (await api.call('households/current',undefined,member.token)).json();assert.equal(current.household.baseCurrency,'EUR','preview makes no currency change');
    api.execute("UPDATE HouseholdSubscriptions SET TrialEndsAt='2020-01-01T00:00:00+00:00'");
    assert.equal((await api.call(path,undefined,owner.token)).status,402);
  } finally {await api.dispose();await f.close();}
});


async function waitCurrencyJob(api,token,id) {
  for(let i=0;i<100;i++) {
    const response=await api.call('households/current',undefined,token);assert.equal(response.status,200);
    const state=await response.json();
    if(state.currencyChange?.id===id && state.currencyChange.state!=='Pending') return state;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.fail('currency job did not finish');
}

test('base currency jobs preserve manual currency pairs through a round trip, reprice originals, convert limits and survive retry/restart',async()=>{
  const f=await fixture(),api=await createApi({env:f.env});
  try {
    const {owner,member,outsider,household,route}=await setup(api);
    let manual=await (await api.call(`${route}/expenses`,input(),member.token)).json();
    manual=await (await api.call(`${route}/transactions/${manual.id}/edit`,{revision:manual.revision,amountMinor:5000,category:'Groceries',occurredOn:'2024-03-30',exchangeRate:0.9},member.token)).json();
    const market=await (await api.call(`${route}/expenses`,input(),member.token)).json();
    const income=await (await api.call(`${route}/incomes`,{...input(),currency:'EUR',amountMinor:1000,category:'Salary'},member.token)).json();
    api.execute("UPDATE Categories SET BudgetLimitMinor=10000 WHERE HouseholdId=? AND Key='Groceries'",household.id.toUpperCase());
    const offlineQuote=await (await api.call(`${route}/exchange-rate?currency=USD&date=2024-03-30`,undefined,member.token)).json();
    const pendingOffline={...input(),estimatedRate:true,rateToken:offlineQuote.token};
    f.setRate(0.8);
    const quote=await (await api.call(`${route}/base-currency/quote?currency=USD`,undefined,owner.token)).json();
    const command={operationId:randomUUID(),quoteToken:quote.token};
    for(const actor of [member,outsider]) assert.equal((await api.call(`${route}/base-currency/confirm`,command,actor.token)).status,403);
    assert.equal((await api.call(`${route}/base-currency/confirm`,command,owner.token)).status,202);
    assert.equal((await api.call(`${route}/base-currency/confirm`,command,owner.token)).status,200);
    assert.equal((await api.call(`${route}/base-currency/confirm`,{...command,operationId:randomUUID()},owner.token)).status,409);
    assert.equal((await (await api.call('households/current',undefined,member.token)).json()).household.baseCurrency,'EUR','queued job leaves a complete old snapshot');
    await api.stop();await api.start({BaseCurrency__Enabled:'true'});
    await api.startReplica({BaseCurrency__Enabled:'true',Recurring__Enabled:'false'});
    let state=await waitCurrencyJob(api,member.token,command.operationId);assert.equal(state.currencyChange.state,'Completed');assert.equal(state.household.baseCurrency,'USD');assert.equal(state.household.currencyRevision,1);
    let entries=state.household.budget.entries;
    let row=entries.find(e=>e.id===manual.id);assert.equal(row.amountMinor,-5000);assert.equal(row.manualRate,0.9);assert.equal(row.exchangeRate,1);assert.equal(row.manualRateFrom,'USD');assert.equal(row.manualRateTo,'EUR');assert.equal(row.rateSource,'Manual rate');
    assert.equal(entries.find(e=>e.id===market.id).amountMinor,-5000);assert.equal(entries.find(e=>e.id===income.id).amountMinor,1250);
    assert.equal(api.query("SELECT BudgetLimitMinor FROM Categories WHERE Key='Groceries'")[0].BudgetLimitMinor,12500);
    assert.ok(transactionCsv(entries,null,'USD',k=>k).csv.includes('"0.9","USD","EUR"'));
    const offline=await api.call(`${route}/expenses`,pendingOffline,member.token);assert.equal(offline.status,201);const uploaded=await offline.json();assert.equal(uploaded.amountMinor,-5000);assert.equal(uploaded.estimatedRate,false,'now-same-currency needs no estimated FX');
    assert.equal((await api.call(`${route}/expenses`,pendingOffline,member.token)).status,200,'offline payload stays idempotent across switch');
    const oldRevision=row.revision;
    const backQuote=await (await api.call(`${route}/base-currency/quote?currency=EUR`,undefined,owner.token)).json();
    f.setRate(0.7);
    assert.equal((await api.call(`${route}/base-currency/confirm`,{operationId:randomUUID(),quoteToken:backQuote.token},owner.token)).status,409,'changed rate needs renewed warning');
    const currentQuote=await (await api.call(`${route}/base-currency/quote?currency=EUR`,undefined,owner.token)).json();
    const back={operationId:randomUUID(),quoteToken:currentQuote.token};assert.equal((await api.call(`${route}/base-currency/confirm`,back,owner.token)).status,202);
    state=await waitCurrencyJob(api,member.token,back.operationId);assert.equal(state.household.baseCurrency,'EUR');assert.equal(state.household.currencyRevision,2);
    entries=state.household.budget.entries;row=entries.find(e=>e.id===manual.id);
    assert.equal(row.amountMinor,-4500);assert.equal(row.manualRate,0.9);assert.equal(row.exchangeRate,0.9);assert.equal(row.originalAmountMinor,5000);assert.equal(row.originalCurrency,'USD');assert.notEqual(row.revision,oldRevision);
    assert.equal(entries.find(e=>e.id===market.id).amountMinor,-3500);assert.equal(entries.find(e=>e.id===income.id).amountMinor,1000);
    assert.equal((await api.call(`${route}/base-currency/confirm`,command,owner.token)).status,200,'old retry does not switch a second time');
    assert.equal(api.query('SELECT CurrencyRevision FROM Households')[0].CurrencyRevision,2);
    assert.equal(api.query('PRAGMA foreign_key_check').length,0);
  } finally {await api.dispose();await f.close();}
});

test('invalid converted amounts fail the entire job without changing currency, other entries or limits',async()=>{
  const f=await fixture(),api=await createApi({env:f.env});
  try {
    const {owner,member,route}=await setup(api);
    await api.call(`${route}/expenses`,{...input(),currency:'EUR',amountMinor:1},member.token);
    await api.call(`${route}/expenses`,input(),member.token);
    const before=await (await api.call('households/current',undefined,member.token)).json();
    f.setRate(1000);
    const quote=await (await api.call(`${route}/base-currency/quote?currency=USD`,undefined,owner.token)).json();
    const command={operationId:randomUUID(),quoteToken:quote.token};assert.equal((await api.call(`${route}/base-currency/confirm`,command,owner.token)).status,202);
    await api.stop();await api.start({BaseCurrency__Enabled:'true'});
    const state=await waitCurrencyJob(api,member.token,command.operationId);assert.equal(state.currencyChange.state,'Failed');assert.equal(state.household.baseCurrency,'EUR');assert.deepEqual(state.household.budget.entries,before.household.budget.entries);
    assert.equal(api.query('SELECT count(*) n FROM CurrencyNotices')[0].n,0);assert.equal(api.query('SELECT count(*) n FROM CurrencyPushDeliveries')[0].n,0,'failed conversions never announce a change');
  } finally {await api.dispose();await f.close();}
});


test('migration preserves the currency pair of previously saved manual rates',async()=>{
  const f=await fixture(),api=await createApi({env:f.env});
  try {
    const {owner,member,route}=await setup(api);
    const entry=await (await api.call(`${route}/expenses`,input(),member.token)).json();
    const manual=await (await api.call(`${route}/transactions/${entry.id}/edit`,{revision:entry.revision,amountMinor:5000,category:'Groceries',occurredOn:'2024-03-30',exchangeRate:0.9},member.token)).json();
    await api.stop();
    api.execute('ALTER TABLE Entries DROP COLUMN ManualRate');api.execute('ALTER TABLE Entries DROP COLUMN ManualRateFrom');api.execute('ALTER TABLE Entries DROP COLUMN ManualRateTo');
    api.execute('ALTER TABLE Households DROP COLUMN CurrencyRevision');api.execute('ALTER TABLE Categories DROP COLUMN BudgetLimitMinor');api.execute('DROP TABLE BaseCurrencyJobs');
    api.execute("DELETE FROM __EFMigrationsHistory WHERE MigrationId LIKE '%_PreserveManualRatesAndCurrencyJobs'");
    await api.start();
    const detail=await (await api.call(`${route}/transactions/${manual.id}`,undefined,owner.token)).json();
    assert.equal(detail.entry.amountMinor,-4500);assert.equal(detail.entry.manualRate,0.9);assert.equal(detail.entry.manualRateFrom,'USD');assert.equal(detail.entry.manualRateTo,'EUR');assert.equal(detail.entry.originalAmountMinor,5000);
  } finally {await api.dispose();await f.close();}
});
