import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID, verify, createHash } from 'node:crypto';
import { createApi } from './helpers/api.mjs';
import { annualStoreOffer, storeManagementUrl } from '../mobile/src/annualStoreOffer.ts';
const password = 'correct horse battery staple';
const product = 'family.annual', basePlan = 'annual';
async function stores() {
  const apple = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const records = new Map(), acknowledgments = new Set();
  let unavailable = false, verifiedRequests = 0;
  const jws = value => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(value)).toString('base64url')}.store-signature`;
  const server = createServer(async (request, response) => {
    function send(value, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); }
    if (unavailable) { send({}, 503); return; }
    try {
      if (request.url === '/oauth') {
        let body = ''; for await (const chunk of request) body += chunk;
        const jwt = new URLSearchParams(body).get('assertion');
        const [header, payload, signature] = jwt.split('.');
        assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, 'service@example.com');
        assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), google.publicKey, Buffer.from(signature, 'base64url')));
        send({ access_token: 'google-test-bearer', expires_in: 1800 }); return;
      }
      if (request.url.startsWith('/apple/')) {
        const jwt = request.headers.authorization?.slice(7), [header, payload, signature] = jwt.split('.');
        const claims = JSON.parse(Buffer.from(payload, 'base64url'));
        assert.equal(claims.aud, 'appstoreconnect-v1'); assert.equal(claims.bid, 'com.example.family');
        assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), { key: apple.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
        verifiedRequests++;
        const id = request.url.split('/').at(-1), record = records.get(id);
        if (!record) { send({}, 404); return; }
        const transaction = { transactionId: id, originalTransactionId: id, bundleId: 'com.example.family', productId: record.product ?? product,
          type: 'Auto-Renewable Subscription', appAccountToken: record.customer, environment: record.environment ?? 'Production', expiresDate: record.expiry,
          ...(record.revoked ? { revocationDate: Date.now() } : {}) };
        if (request.url.includes('/transactions/')) send({ signedTransactionInfo: jws(transaction) });
        else send({ data: [{ lastTransactions: [{ status: record.appleStatus ?? (record.revoked ? 5 : record.grace ? 4 : 1), signedTransactionInfo: jws(transaction), signedRenewalInfo: jws({ autoRenewStatus: record.renew === false ? 0 : 1, ...(record.grace ? { gracePeriodExpiresDate: record.grace } : {}) }) }] }] });
        return;
      }
      assert.equal(request.headers.authorization, 'Bearer google-test-bearer');
      verifiedRequests++;
      const token = decodeURIComponent(request.url.split('/').at(-1).replace(':acknowledge', ''));
      const record = records.get(token); if (!record) { send({}, 404); return; }
      if (request.url.endsWith(':acknowledge')) { acknowledgments.add(token); send({}); return; }
      send({ subscriptionState: record.state ?? 'SUBSCRIPTION_STATE_ACTIVE',
        acknowledgementState: acknowledgments.has(token) ? 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' : 'ACKNOWLEDGEMENT_STATE_PENDING',
        externalAccountIdentifiers: { obfuscatedExternalAccountId: createHash('sha256').update(record.customer).digest('hex') },
        ...(record.test ? { testPurchase: {} } : {}),
        lineItems: [{ productId: record.product ?? product, expiryTime: new Date(record.expiry).toISOString(), offerDetails: { basePlanId: record.basePlan ?? basePlan }, autoRenewingPlan: { autoRenewEnabled: record.renew !== false } }],
      });
    } catch { send({ error: 'invalid store request' }, 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  return { records, acknowledgments, setUnavailable: value => { unavailable = value; }, requests: () => verifiedRequests,
    close: () => new Promise(resolve => server.close(resolve)),
    env: { Billing__ReconcileEnabled: 'false', Billing__Apple__IssuerId: 'issuer', Billing__Apple__KeyId: 'key', Billing__Apple__PrivateKeyPem: apple.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      Billing__Apple__BundleId: 'com.example.family', Billing__Apple__AnnualProductId: product, Billing__Apple__BaseUrl: `${root}/apple/`,
      Billing__Google__ClientEmail: 'service@example.com', Billing__Google__PrivateKeyPem: google.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      Billing__Google__PackageName: 'com.example.family', Billing__Google__AnnualProductId: product, Billing__Google__AnnualBasePlanId: basePlan,
      Billing__Google__TokenUrl: `${root}/oauth`, Billing__Google__BaseUrl: `${root}/google/` },
  };
}
async function register(api, name) { const r = await api.call('auth/register', { email: `${name}@example.com`, password }); assert.equal(r.status, 201); return r.json(); }
async function family(api, owner, name) { const r = await api.call('households', { name }, owner.token); assert.equal(r.status, 201); return r.json(); }
async function join(api, owner, member) { const invite = await (await api.call('households/current/invites', {}, owner.token)).json(); assert.equal((await api.call('invites/redeem', { code: invite.code }, member.token)).status, 200); }
async function status(api, household, user, store = 'APP_STORE') { const r = await api.call(`households/${household.id}/subscription?store=${store}`, undefined, user.token); assert.equal(r.status, 200); return r.json(); }

test('annual Apple purchase is server verified for one household, shared with all four members and durable through owner handover', async () => {
  const fixture = await stores(), api = await createApi({ env: fixture.env });
  try {
    await api.start(); const owner = await register(api, 'owner'), members = [];
    const household = await family(api, owner, 'Family');
    for (let i = 0; i < 3; i++) { const member = await register(api, `member${i}`); await join(api, owner, member); members.push(member); }
    const other = await register(api, 'other'), otherFamily = await family(api, other, 'Other');
    const trial = await status(api, household, owner);
    assert.equal(trial.subscription.status, 'Trial'); assert.equal(trial.subscription.subscribed, false); assert.equal(trial.subscription.planCap, 4);
    assert.equal(Date.parse(trial.subscription.trialEndsAt) - Date.parse(trial.subscription.trialStartedAt), 7 * 86400000);
    assert.ok(trial.subscription.customerId); assert.equal(trial.subscription.canPurchase, true);
    const path = `households/${household.id}/subscription/verify`, input = { store: 'APP_STORE', reference: '100001' };
    assert.equal((await api.call(path, input)).status, 401);
    assert.equal((await api.call(path, input, members[0].token)).status, 403);
    assert.equal((await api.call(path, input, other.token)).status, 403);
    assert.equal((await api.call(path, { subscribed: true, paidThrough: '2099-01-01' }, owner.token)).status, 400);
    fixture.records.set(input.reference, { customer: trial.subscription.customerId, expiry: Date.now() + 365 * 86400000 });
    for (let i = 0; i < 2; i++) {
      const response = await api.call(path, input, owner.token); assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).subscribed, true);
    }
    for (const member of members) {
      const shared = await status(api, household, member);
      assert.equal(shared.subscription.subscribed, true); assert.equal(shared.subscription.canPurchase, false); assert.equal(shared.subscription.customerId, null);
      assert.equal((await api.call(`households/${household.id}/expenses`, { id: randomUUID(), amountMinor: 100, category: 'Groceries', occurredOn: '2026-11-17', authorName: 'Member', note: '' }, member.token)).status, 201);
    }
    assert.equal((await status(api, otherFamily, other)).subscription.subscribed, false);
    assert.equal((await api.call(`households/${otherFamily.id}/subscription/verify`, input, other.token)).status, 400, 'purchase cannot cover an unrelated household');
    const stored = api.query('SELECT * FROM HouseholdSubscriptions WHERE PurchaseHash IS NOT NULL');
    assert.equal(stored.length, 1); assert.ok(!JSON.stringify(stored).includes('100001'));
    assert.ok(fixture.requests() >= 4);
    assert.equal((await api.call('account/delete', { password, successorId: members[0].user.id }, owner.token)).status, 204);
    const inherited = await status(api, household, members[0]);
    assert.equal(inherited.role, 'Owner'); assert.equal(inherited.subscription.customerId, trial.subscription.customerId); assert.equal(inherited.subscription.subscribed, true);
    await api.stop(); await api.start();
    assert.equal((await status(api, household, members[1])).subscription.subscribed, true);
    assert.equal((await api.call(path, input, members[0].token)).status, 200, 'encrypted reference/key ring survives restart');
    assert.deepEqual(api.query('PRAGMA foreign_key_check'), []);
  } finally { await api.dispose(); await fixture.close(); }
});

test('Google annual verification validates household, base plan, payment state, and acknowledges only verified purchases', async () => {
  const fixture = await stores(), api = await createApi({ env: fixture.env });
  try {
    await api.start(); const owner = await register(api, 'owner'), household = await family(api, owner, 'Family');
    const trial = await status(api, household, owner, 'PLAY_STORE'), path = `households/${household.id}/subscription/verify`;
    const reference = 'google-token-private';
    const record = { customer: trial.subscription.customerId, expiry: Date.now() + 365 * 86400000 };
    for (const bad of [{ customer: randomUUID() }, { basePlan: 'monthly' }, { product: 'other' }, { state: 'SUBSCRIPTION_STATE_PENDING' }, { test: true }]) {
      fixture.records.set(reference, { ...record, ...bad });
      assert.equal((await api.call(path, { store: 'PLAY_STORE', reference }, owner.token)).status, 400);
      assert.equal(fixture.acknowledgments.size, 0);
    }
    fixture.records.set(reference, record);
    const result = await api.call(path, { store: 'PLAY_STORE', reference }, owner.token);
    assert.equal(result.status, 200, await result.clone().text()); assert.equal((await result.json()).subscribed, true);
    assert.equal(fixture.acknowledgments.size, 1);
    assert.equal((await api.call(path, { store: 'PLAY_STORE', reference }, owner.token)).status, 200);
    assert.ok(!JSON.stringify(api.query('SELECT * FROM HouseholdSubscriptions')).includes(reference));
    fixture.records.set(reference, { ...record, renew: false, state: 'SUBSCRIPTION_STATE_CANCELED' });
    const cancelled = await (await api.call(path, { store: 'PLAY_STORE', reference }, owner.token)).json();
    assert.equal(cancelled.subscribed, true); assert.equal(cancelled.willRenew, false);
    fixture.records.set(reference, { ...record, state: 'SUBSCRIPTION_STATE_ON_HOLD' });
    assert.equal((await (await api.call(path, { store: 'PLAY_STORE', reference }, owner.token)).json()).subscribed, false);
    assert.equal((await status(api, household, owner, 'PLAY_STORE')).subscription.canPurchase, false, 'billing retry must not invite a duplicate subscription');
  } finally { await api.dispose(); await fixture.close(); }
});

test('store failures and wrong Apple claims never activate subscriptions; reconciliation updates refunds without the app', async () => {
  const fixture = await stores(), api = await createApi({ env: fixture.env });
  try {
    await api.start(); const owner = await register(api, 'owner'), household = await family(api, owner, 'Family');
    const trial = await status(api, household, owner), path = `households/${household.id}/subscription/verify`;
    const input = { store: 'APP_STORE', reference: '100002' }, record = { customer: trial.subscription.customerId, expiry: Date.now() + 365 * 86400000 };
    for (const bad of [{ customer: randomUUID() }, { product: 'monthly' }, { environment: 'Sandbox' }]) {
      fixture.records.set(input.reference, { ...record, ...bad });
      assert.equal((await api.call(path, input, owner.token)).status, 400);
    }
    fixture.setUnavailable(true);
    assert.equal((await api.call(path, input, owner.token)).status, 503);
    assert.equal((await status(api, household, owner)).subscription.subscribed, false);
    fixture.setUnavailable(false); fixture.records.set(input.reference, record);
    assert.equal((await api.call(path, input, owner.token)).status, 200);
    fixture.records.set(input.reference, { ...record, revoked: true });
    await api.stop(); await api.start({ Billing__ReconcileEnabled: 'true', Billing__PollSeconds: '10' });
    for (let i = 0; i < 100 && !api.query('SELECT Revoked FROM HouseholdSubscriptions')[0].Revoked; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(api.query('SELECT Revoked FROM HouseholdSubscriptions')[0].Revoked, 1);
    assert.equal((await status(api, household, owner)).subscription.subscribed, false);
  } finally { await api.dispose(); await fixture.close(); }
});

test('unconfigured billing fails closed and trial dates do not reset across restarts', async () => {
  const api = await createApi();
  try {
    await api.start(); const owner = await register(api, 'owner'), household = await family(api, owner, 'Family');
    const before = await status(api, household, owner);
    assert.equal(before.subscription.billingAvailable, false); assert.equal(before.subscription.customerId, null);
    assert.equal((await api.call(`households/${household.id}/subscription/verify`, { store: 'APP_STORE', reference: '123' }, owner.token)).status, 503);
    await api.stop(); await api.start();
    assert.deepEqual((await status(api, household, owner)).subscription, before.subscription);
    api.execute("UPDATE HouseholdSubscriptions SET TrialEndsAt = '2000-01-01T00:00:00+00:00'");
    assert.equal((await status(api, household, owner)).subscription.status, 'Expired');
    await api.stop(); await api.start();
    assert.equal((await status(api, household, owner)).subscription.status, 'Expired', 'restart cannot restart an expired trial');
  } finally { await api.dispose(); }
});

test('store offer selection uses only genuine annual localized prices, excluding monthly/installment and intro offers', () => {
  const ios = { id: product, type: 'subs', platform: 'ios', subscriptionPeriodUnitIOS: 'year', subscriptionPeriodNumberIOS: '1', displayPrice: '24,99 €' };
  assert.equal(storeManagementUrl('APP_STORE'), 'https://apps.apple.com/account/subscriptions');
  assert.equal(storeManagementUrl('PLAY_STORE', 'family.annual', 'com.example.family'), 'https://play.google.com/store/account/subscriptions?sku=family.annual&package=com.example.family');
  assert.equal(storeManagementUrl('PLAY_STORE'), 'https://play.google.com/store/account/subscriptions');
  assert.equal(annualStoreOffer([ios], product).price, '24,99 €');
  assert.equal(annualStoreOffer([{ ...ios, subscriptionPeriodUnitIOS: 'month' }], product), null);
  const phase = { billingPeriod: 'P1Y', recurrenceMode: 1, formattedPrice: '$24.99' };
  const offer = { basePlanIdAndroid: basePlan, offerTokenAndroid: 'annual-offer', pricingPhasesAndroid: { pricingPhaseList: [phase] } };
  const android = { id: product, type: 'subs', platform: 'android', subscriptionOffers: [offer] };
  assert.deepEqual(annualStoreOffer([android], product, basePlan), { productId: product, price: '$24.99', offerToken: 'annual-offer' });
  assert.equal(annualStoreOffer([android], product, 'monthly'), null);
  assert.equal(annualStoreOffer([{ ...android, subscriptionOffers: [{ ...offer, pricingPhasesAndroid: { pricingPhaseList: [{ ...phase, billingPeriod: 'P1M' }] } }] }], product, basePlan), null);
});

import { budgetCanWrite } from '../mobile/src/budgetAccess.ts';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

test('expired trial is read-only for every member, preserving reads/privacy/export and resuming writes/recurring after verification', async () => {
  const fixture = await stores(), api = await createApi({ env: fixture.env });
  try {
    await api.start(); const owner = await register(api, 'owner'), member = await register(api, 'member'), household = await family(api, owner, 'Family');
    await join(api, owner, member);
    const route = `households/${household.id}`, today = new Date().toISOString().slice(0, 10);
    const input = { id: randomUUID(), amountMinor: 100, category: 'Groceries', occurredOn: today, authorName: 'Owner', note: '' };
    const original = await (await api.call(`${route}/expenses`, input, owner.token)).json();
    const ruleId = randomUUID();
    const rule = await (await api.call(`${route}/recurring`, { id: ruleId, amountMinor: 123, currency: 'EUR', type: 'Expense', category: 'Housing', frequency: 'Monthly', startDate: today, dayOfMonth: Number(today.slice(8)) }, owner.token)).json();
    const missedId = randomUUID();
    const yesterday = new Date(Date.parse(today + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
    assert.equal((await api.call(`${route}/recurring`, { id: missedId, amountMinor: 111, currency: 'EUR', type: 'Expense', category: 'Housing', frequency: 'Monthly', startDate: yesterday, dayOfMonth: Number(yesterday.slice(8)) }, owner.token)).status, 201);
    const customer = (await status(api, household, owner)).subscription.customerId;
    api.execute("UPDATE HouseholdSubscriptions SET TrialEndsAt = '2000-01-01T00:00:00+00:00'");
    const runner = resolve('tests/FamilyBudget.SchedulerChecks/bin/Debug/net10.0/FamilyBudget.SchedulerChecks.dll');
    execFileSync('dotnet', [runner, api.databasePath, today], { windowsHide: true, timeout: 30000 });
    assert.equal(api.query('SELECT count(*) AS n FROM RecurringOccurrences')[0].n, 0);
    for (const actor of [owner, member]) {
      assert.equal((await api.call(`${route}/expenses`, { ...input, id: randomUUID() }, actor.token)).status, 402);
      assert.equal((await api.call(`${route}/incomes`, { ...input, id: randomUUID(), category: 'Salary' }, actor.token)).status, 402);
      const state = await (await api.call('households/current', undefined, actor.token)).json();
      assert.equal(state.access.canWrite, false); assert.equal(state.household.budget.entries.length, 1);
    }
    assert.equal((await api.call(`${route}/expenses`, input, owner.token)).status, 200, 'already-accepted upload retry is acknowledged without a new write');
    const change = { revision: original.revision, amountMinor: 200, category: 'Groceries', occurredOn: today, note: '' };
    assert.equal((await api.call(`${route}/transactions/${original.id}/edit`, change, owner.token)).status, 402);
    assert.equal((await api.call(`${route}/transactions/${original.id}/delete`, { revision: original.revision }, owner.token)).status, 402);
    assert.equal((await api.call(`${route}/transactions/${original.id}/edit`, change, member.token)).status, 403, 'ownership authorization still precedes billing status');
    assert.equal((await api.call(`${route}/categories/save`, { type: 'Expense', name: 'New', colour: '#245C48' }, owner.token)).status, 402);
    assert.equal((await api.call(`${route}/categories/archive`, { type: 'Expense', key: 'Housing' }, owner.token)).status, 402);
    assert.equal((await api.call(`${route}/recurring`, { ...rule.rule, id: randomUUID() }, owner.token)).status, 402);
    assert.equal((await api.call(`${route}/recurring/${ruleId}/change`, { operationId: randomUUID(), revision: rule.rule.revision, action: 'amount', amountMinor: 999 }, owner.token)).status, 402);
    assert.equal((await api.call('account/data', { password }, member.token)).status, 200, 'privacy access is never paywalled');
    fixture.records.set('100005', { customer, expiry: Date.now() + 365 * 86400000 });
    assert.equal((await api.call(`${route}/subscription/verify`, { store: 'APP_STORE', reference: '100005' }, owner.token)).status, 200);
    assert.equal((await (await api.call('households/current', undefined, member.token)).json()).access.canWrite, true);
    assert.equal((await api.call(`${route}/expenses`, { ...input, id: randomUUID() }, member.token)).status, 201);
    execFileSync('dotnet', [runner, api.databasePath, today], { windowsHide: true, timeout: 30000 });
    assert.equal(api.query('SELECT count(*) AS n FROM RecurringOccurrences')[0].n, 1, 'rules resume from today without backfilling missed dates');
    assert.equal(api.query(`SELECT count(*) AS n FROM RecurringOccurrences WHERE DueDate < '${today}'`)[0].n, 0);
  } finally { await api.dispose(); await fixture.close(); }
});

test('cached budget access expires offline and honors paid/grace periods and revocation', () => {
  const access = { canWrite: true, trialEndsAt: '2026-11-24T00:00:00Z', paidThrough: null, graceThrough: null, revoked: false };
  assert.equal(budgetCanWrite(access, Date.parse('2026-11-23T00:00:00Z')), true);
  assert.equal(budgetCanWrite(access, Date.parse('2026-11-24T00:00:00Z')), false);
  assert.equal(budgetCanWrite({ ...access, paidThrough: '2027-11-17T00:00:00Z' }, Date.parse('2026-12-01T00:00:00Z')), true);
  assert.equal(budgetCanWrite({ ...access, graceThrough: '2026-12-02T00:00:00Z' }, Date.parse('2026-12-01T00:00:00Z')), true);
  assert.equal(budgetCanWrite({ ...access, revoked: true, paidThrough: '2027-11-17T00:00:00Z' }, Date.parse('2026-12-01T00:00:00Z')), false);
});


test('retention checks pending renewal before deletion and defers cleanup on a store outage', async () => {
  const fixture = await stores(), api = await createApi({ env: fixture.env });
  try {
    await api.start(); const owner = await register(api, 'owner'), household = await family(api, owner, 'Family');
    const customer = (await status(api, household, owner)).subscription.customerId;
    fixture.records.set('100009', { customer, expiry: Date.now() + 365 * 86400000 });
    assert.equal((await api.call(`households/${household.id}/subscription/verify`, { store: 'APP_STORE', reference: '100009' }, owner.token)).status, 200);
    await api.stop();
    const old = days => new Date(Date.now() - days * 86400000).toISOString();
    api.execute('UPDATE HouseholdSubscriptions SET TrialEndsAt = ?, PaidThrough = ?, VerifiedAt = ?, WillRenew = 1', old(120), old(100), old(110));
    await api.start({ Retention__Enabled: 'true', Retention__PollSeconds: '1' });
    for (let i = 0; i < 100 && Date.parse(api.query('SELECT PaidThrough FROM HouseholdSubscriptions')[0].PaidThrough) < Date.now(); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await status(api, household, owner)).subscription.subscribed, true, 'verified renewal prevents deletion');
    fixture.setUnavailable(true);
    api.execute('UPDATE HouseholdSubscriptions SET TrialEndsAt = ?, PaidThrough = ?, VerifiedAt = ?, WillRenew = 1', old(120), old(100), old(110));
    await new Promise(resolve => setTimeout(resolve, 1800));
    assert.equal(api.query('SELECT count(*) AS n FROM Households')[0].n, 1, 'unknown paid state must not trigger destructive cleanup');
    fixture.setUnavailable(false);
    fixture.records.set('100009', { customer, expiry: Date.now() - 100 * 86400000, renew: false, appleStatus: 2 });
    for (let i = 0; i < 100 && api.query('SELECT count(*) AS n FROM Households')[0].n; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(api.query('SELECT count(*) AS n FROM Households')[0].n, 0, 'confirmed expired paid household is deleted after its 90-day window');
    assert.equal((await api.call('auth/me', undefined, owner.token)).status, 200);

  } finally { await api.dispose(); await fixture.close(); }
});


for (const store of ['APP_STORE','PLAY_STORE']) test(`${store} reactivation preserves records and settings, restores all members, and resumes only billing-paused schedules`, async()=>{
  const fixture=await stores(), api=await createApi({env:fixture.env});
  try {
    await api.start(); const owner=await register(api,'reactivate-owner'), member=await register(api,'reactivate-member');
    const household=await family(api,owner,'Keep our family'); await join(api,owner,member);
    const route=`households/${household.id}`, reference=store==='APP_STORE'?'100009':'google-reactivation';
    const customer=(await status(api,household,owner,store)).subscription.customerId;
    const today=new Date().toISOString().slice(0,10), date=days=>new Date(Date.parse(today+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
    const purchase=()=>api.call(`${route}/subscription/verify`,{store,reference},owner.token);
    if (store==='PLAY_STORE') {
      fixture.records.set(reference,{customer,expiry:Date.now()+86400000}); assert.equal((await purchase()).status,200);
    }
    assert.equal((await api.call('households/current/member-limit',{limit:3},owner.token)).status,200);
    const custom=await api.call(`${route}/categories/save`,{type:'Expense',name:'Family memories',colour:'#245C48'},owner.token);
    assert.equal(custom.status,200);
    const category=(await custom.json()).key;
    const entry=await (await api.call(`${route}/expenses`,{id:randomUUID(),amountMinor:1299,category,occurredOn:date(-60),authorName:'Original member',note:'Keep this note'},member.token)).json();
    assert.equal((await api.call(`${route}/categories/archive`,{key:category,type:'Expense'},owner.token)).status,204);
    async function rule(start,action) {
      const result=await api.call(`${route}/recurring`,{id:randomUUID(),amountMinor:777,currency:'EUR',type:'Expense',category:'Housing',frequency:'Monthly',startDate:start,dayOfMonth:Number(start.slice(8))},owner.token);
      assert.equal(result.status,201); let value=(await result.json()).rule;
      if(action) {const changed=await api.call(`${route}/recurring/${value.id}/change`,{operationId:randomUUID(),revision:value.revision,action},owner.token);assert.equal(changed.status,200);value=(await changed.json()).rule;}
      return value;
    }
    const missed=await rule(date(-1)), dueToday=await rule(today), paused=await rule(date(-1),'pause'), stopped=await rule(date(-1),'stop'), future=await rule(today);
    const futureDate=date(400); api.execute('UPDATE RecurringRules SET NextDueDate = ? WHERE Id = ?',futureDate,future.id.toUpperCase());
    api.execute('INSERT INTO RecurringOccurrences (RuleId,DueDate,EntryId) VALUES (?,?,?)',missed.id.toUpperCase(),date(-60),entry.id.toUpperCase());
    api.execute('UPDATE HouseholdSubscriptions SET TrialEndsAt = ?',new Date(Date.now()-10*86400000).toISOString());
    if(store==='PLAY_STORE') {
      fixture.records.set(reference,{customer,expiry:Date.now()-2*86400000,state:'SUBSCRIPTION_STATE_EXPIRED',renew:false}); assert.equal((await purchase()).status,200);
    } else api.execute('UPDATE HouseholdSubscriptions SET TrialEndsAt = ?',new Date(Date.now()-2*86400000).toISOString());
    const tables=['Entries','Categories','Memberships','Households','Budgets','RecurringAmounts','RecurringChanges','RecurringOccurrences'];
    const snapshot=()=>Object.fromEntries(tables.map(table=>[table,api.query(`SELECT * FROM ${table} ORDER BY rowid`)]));
    const before=snapshot();
    for(const actor of [owner,member]) {const state=await (await api.call('households/current',undefined,actor.token)).json(); assert.equal(state.access.canWrite,false);assert.ok(state.access.retention);}
    const path=`${route}/subscription/verify`;
    assert.equal((await api.call(path,{store,reference},member.token)).status,403);
    fixture.records.set(reference,{customer,expiry:Date.now()+365*86400000});
    fixture.setUnavailable(true); assert.equal((await purchase()).status,503); fixture.setUnavailable(false);
    assert.deepEqual(snapshot(),before,'failed verification preserves all data');
    assert.equal((await (await api.call('households/current',undefined,member.token)).json()).access.canWrite,false);
    const verified=await purchase();assert.equal(verified.status,200);const restored=await verified.json();assert.equal(restored.subscribed,true);assert.equal(restored.retention,null);
    const afterReactivation=snapshot();
    assert.ok(afterReactivation.Households[0].DataRevision>before.Households[0].DataRevision,'resumed recurring cursors invalidate cached reads');
    const expectedReactivation=before;expectedReactivation.Households[0].DataRevision=afterReactivation.Households[0].DataRevision;
    assert.deepEqual(afterReactivation,expectedReactivation,'reactivation preserves records and settings while advancing the read revision');
    for(const actor of [owner,member]) {const state=await (await api.call('households/current',undefined,actor.token)).json();assert.equal(state.access.canWrite,true);assert.equal(state.access.retention,null);assert.equal(state.household.budget.entries[0].authorName,'Original member');assert.equal(state.household.budget.entries[0].description,'Keep this note');}
    assert.equal((await (await api.call('households/current/members',undefined,owner.token)).json()).canInvite,true);
    const cursors=()=>api.query('SELECT Id,NextDueDate,Active,Stopped FROM RecurringRules ORDER BY Id');
    const byId=id=>cursors().find(row=>row.Id===id.toUpperCase());
    assert.ok(byId(missed.id).NextDueDate>today);assert.equal(byId(dueToday.id).NextDueDate,today);
    assert.equal(byId(paused.id).Active,0);assert.equal(byId(stopped.id).Stopped,1);assert.equal(byId(future.id).NextDueDate,futureDate);
    const resumed=cursors(); assert.equal((await purchase()).status,200);assert.deepEqual(cursors(),resumed,'replayed store confirmation cannot rewind schedules');
    const runner=resolve('tests/FamilyBudget.SchedulerChecks/bin/Debug/net10.0/FamilyBudget.SchedulerChecks.dll');
    for(let i=0;i<2;i++) execFileSync('dotnet',[runner,api.databasePath,today],{windowsHide:true,timeout:30000});
    assert.equal(api.query('SELECT count(*) n FROM RecurringOccurrences')[0].n,2,'one existing historical occurrence plus exactly one due today');
    assert.equal(api.query(`SELECT count(*) n FROM RecurringOccurrences WHERE DueDate < '${today}'`)[0].n,1,'historical entries stay; missed dates do not backfill');
    assert.equal((await api.call(`${route}/expenses`,{id:randomUUID(),amountMinor:777,category:'Housing',occurredOn:date(-1),authorName:'Member',note:'Entered missed payment manually'},member.token)).status,201);
    await api.stop();await api.start({Retention__Enabled:'true',Retention__TrialDays:'1',Retention__PaidDays:'1'});
    assert.equal((await (await api.call('households/current',undefined,member.token)).json()).access.canWrite,true,'cleanup skips the restored household even after its old deadline');
    assert.equal(api.query('SELECT count(*) n FROM RetentionAudits')[0].n,0);
    assert.deepEqual(api.query('PRAGMA foreign_key_check'),[]);
  } finally {await api.dispose();await fixture.close();}
});
