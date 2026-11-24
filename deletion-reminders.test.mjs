import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from './helpers/api.mjs';

async function fixtures() {
  const emails = [], pushes = []; let failEmail = false, deadDevice = false, rejected = 0;
  const requests = [];
  const accepted = new Map();
  const email = createServer(async (req,res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), key = req.headers['idempotency-key'];
    requests.push({ key, body });
    assert.equal(req.url, '/emails'); assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, 'Bearer re_fixture_only');
    assert.ok(key && key.length <= 256);
    assert.equal(body.from,'Kin <budget@example.com>');
    res.setHeader('Content-Type','application/json');
    if (failEmail) { rejected++; res.writeHead(429); res.end(JSON.stringify({message:'Rate limited'})); return; }
    if (!accepted.has(key)) { emails.push({recipient:body.to[0],content:body.html ?? body.text}); accepted.set(key,`mail-${emails.length}`); }
    res.end(JSON.stringify({id:accepted.get(key)}));
  });
  await new Promise(resolve => email.listen(0,'127.0.0.1',resolve));
  const push = createServer(async (req,res) => { let body=''; for await (const chunk of req) body+=chunk; pushes.push(JSON.parse(body)); res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({data: deadDevice ? {status:'error', details:{error:'DeviceNotRegistered'}} : {status:'ok', id:'fixture-ticket'}})); });
  await new Promise(resolve => push.listen(0,'127.0.0.1',resolve));
  return { emails, pushes, requests, get rejected() { return rejected; }, fail: value => failEmail=value, dead: value => deadDevice=value,
    env: { Reminders__Resend__ApiKey:'re_fixture_only', Reminders__Resend__From:'Kin <budget@example.com>', Reminders__Resend__SendUrl:`http://127.0.0.1:${email.address().port}/emails`, Reminders__PushUrl:`http://127.0.0.1:${push.address().port}/send`, Reminders__PollSeconds:'1' },
    async close() { await Promise.all([new Promise(r=>email.close(r)),new Promise(r=>push.close(r))]); } };

}
const password='Family-budget-123!';
async function register(api,email) { return (await (await api.call('auth/register',{email,password})).json()); }
async function waitFor(check, debug) { for(let i=0;i<100;i++){ if(check()) return; await delay(100); } assert.ok(check(),debug ? JSON.stringify(debug()) : 'timed out'); }
function decoded(mail) { return mail.content; }

test('verification requires an emailed single-use secret, binds to the account, expires, and rate limits requests', async()=>{
  const f=await fixtures(), api=await createApi({env:f.env});
  try {
    await api.start(); const owner=await register(api,'owner@example.com'), member=await register(api,'member@example.com');
    assert.equal((await api.call('account/email-verification/request',{},owner.token)).status,204);
    assert.equal(f.emails.length,1);
    const body=decoded(f.emails[0]); const code=body.match(/[A-F0-9]{48}/)?.[0]; assert.ok(code,body);
    assert.equal(api.query('SELECT CodeHash FROM EmailVerifications')[0].CodeHash,createHash('sha256').update(code).digest('hex').toUpperCase());
    assert.equal((await api.call('account/email-verification/request',{},owner.token)).status,429);
    assert.equal((await api.call('account/email-verification/confirm',{code},member.token)).status,400);
    assert.equal((await api.call('account/email-verification/confirm',{code:'0'.repeat(48)},owner.token)).status,400);
    api.execute('UPDATE EmailVerifications SET ExpiresAt = ?',new Date(Date.now()-1000).toISOString());
    assert.equal((await api.call('account/email-verification/confirm',{code},owner.token)).status,400);
    api.execute('UPDATE EmailVerifications SET ExpiresAt = ?',new Date(Date.now()+3600000).toISOString());
    assert.equal((await api.call('account/email-verification/confirm',{code},owner.token)).status,204);
    assert.equal((await api.call('account/email-verification/confirm',{code},owner.token)).status,400);
    assert.equal((await (await api.call('auth/me',undefined,owner.token)).json()).emailVerified,true);
    assert.equal(api.query('SELECT count(*) n FROM EmailVerifications')[0].n,0);
  } finally { await api.dispose(); await f.close(); }
});

test('daily reminders reach only verified owners at start, seven days and one day with links, retries and durable deduplication',async()=>{
  const f=await fixtures(),api=await createApi({env:f.env});
  try {
    await api.start(); const owner=await register(api,'owner@example.com'),member=await register(api,'member@example.com');
    const family=await (await api.call('households',{name:'Family'},owner.token)).json();
    const invite=await (await api.call('households/current/invites',{},owner.token)).json();
    await api.call('invites/redeem',{code:invite.code},member.token);
    for(const actor of [owner,member]) assert.equal((await api.call('account/reminder-preferences',{language:'bg',pushAllowed:true,pushToken:`ExpoPushToken[${actor.user.id}]`},actor.token)).status,204);
    const ago=days=>new Date(Date.now()-days*86400000).toISOString();
    api.execute('UPDATE HouseholdSubscriptions SET TrialEndsAt = ?',ago(1));
    await api.stop(); await api.start({Reminders__Enabled:'true'}); await delay(1200);
    assert.equal(f.emails.length,0); assert.equal(f.pushes.length,0,'unverified owner receives neither channel');
    api.execute('UPDATE Accounts SET EmailVerified = 1');
    await waitFor(()=>f.emails.length===1 && f.pushes.length===1);
    await waitFor(()=>api.query('SELECT count(*) n FROM DeletionReminders WHERE SentAt IS NOT NULL')[0].n===2);
    assert.match(f.emails[0].recipient,/owner@example.com/);
    assert.match(decoded(f.emails[0]),/household-manager-mobile:\/\/subscription/);
    assert.match(decoded(f.emails[0]),/household-manager-mobile:\/\/settings\?section=household/);
    assert.match(decoded(f.emails[0]),/UTC/);
    assert.equal(f.pushes[0].to,`ExpoPushToken[${owner.user.id}]`);
    assert.equal(f.pushes[0].data.exportUrl,'household-manager-mobile://settings?section=household');
    assert.match(f.pushes[0].body,/Данните/);
    await api.stop(); await api.start({Reminders__Enabled:'true'}); await delay(1200);
    assert.equal(f.emails.length,1); assert.equal(f.pushes.length,1);
    await api.startReplica({ Reminders__Enabled:'true', Recurring__Enabled:'false' });
    f.fail(true); api.execute('UPDATE HouseholdSubscriptions SET TrialEndsAt = ?',ago(23));
    await waitFor(()=>api.query("SELECT count(*) n FROM DeletionReminders WHERE Stage = 'seven-days'")[0].n>=1);
    await waitFor(()=>f.rejected > 0);
    assert.equal(f.emails.length,1);
    // Only email is failing. Wait for the successful push acknowledgement before
    // advancing retry timestamps, so the fixture cannot expire an in-flight push lease.
    await waitFor(()=>api.query("SELECT count(*) n FROM DeletionReminders WHERE Stage = 'seven-days' AND SentAt IS NOT NULL")[0].n===1);
    f.fail(false); api.execute("UPDATE DeletionReminders SET RetryAt = '2000-01-01T00:00:00+00:00' WHERE SentAt IS NULL");
    await waitFor(()=>f.emails.length===2 && f.pushes.length===2,()=>({emails:f.emails.length,pushes:f.pushes.length,rows:api.query('SELECT Stage,SentAt,Attempts,RetryAt FROM DeletionReminders')}));
    await waitFor(()=>api.query("SELECT count(*) n FROM DeletionReminders WHERE Stage = 'seven-days' AND SentAt IS NOT NULL")[0].n===2);
    const attempts = f.requests.filter(r => r.body.subject === f.requests.at(-1).body.subject && r.body.text === f.requests.at(-1).body.text);
    assert.ok(attempts.length >= 2);
    assert.equal(new Set(attempts.map(r=>r.key)).size,1,'Resend retries use an identical idempotency key');
    api.execute('UPDATE HouseholdSubscriptions SET TrialEndsAt = ?',ago(29));
    await waitFor(()=>f.emails.length===3 && f.pushes.length===3);
    assert.equal(api.query("SELECT count(*) n FROM DeletionReminders WHERE Stage = 'one-day'")[0].n,2);
    // Restored access suppresses new reminders, even with an already queued failed attempt.
    api.execute('UPDATE HouseholdSubscriptions SET TrialEndsAt = ?',new Date(Date.now()+86400000).toISOString());
    await delay(1200); assert.equal(f.emails.length,3);
    assert.equal((await api.call('account/reminder-preferences',{language:'bg',pushAllowed:false},owner.token)).status,204);
    assert.equal(api.query(`SELECT PushToken FROM Sessions WHERE AccountId = '${owner.user.id.toUpperCase()}'`)[0].PushToken,null);
    assert.deepEqual(api.query('PRAGMA foreign_key_check'),[]);
  } finally {await api.dispose(); await f.close();}
});

test('paid access suppresses reminders; paid expiry uses its deadline and removes rejected device tokens', async()=>{
  const f=await fixtures(),api=await createApi({env:f.env});
  try {
    await api.start(); const owner=await register(api,'paid@example.com');
    await api.call('households',{name:'Paid family'},owner.token);
    await api.call('account/reminder-preferences',{language:'en',pushAllowed:true,pushToken:'ExpoPushToken[dead-device]'},owner.token);
    const at=days=>new Date(Date.now()+days*86400000).toISOString();
    api.execute('UPDATE Accounts SET EmailVerified = 1');
    api.execute('UPDATE HouseholdSubscriptions SET TrialEndsAt = ?, PurchaseHash = ?, PaidThrough = ?, VerifiedAt = ?, WillRenew = 0',at(-100),'fixture-paid',at(1),at(0));
    await api.stop(); await api.start({Reminders__Enabled:'true'}); await delay(1200);
    assert.equal(f.emails.length,0,'paid term is still active despite the trial having ended');
    assert.equal(f.pushes.length,0);
    f.dead(true);
    api.execute('UPDATE HouseholdSubscriptions SET PaidThrough = ?',at(-83));
    await waitFor(()=>f.emails.length===1 && f.pushes.length===1);
    await waitFor(()=>api.query('SELECT PushToken FROM Sessions')[0].PushToken===null);
    assert.equal(api.query('SELECT Stage FROM DeletionReminders')[0].Stage,'seven-days');
    assert.match(decoded(f.emails[0]),/href="household-manager-mobile:\/\/subscription"/);
    api.execute('UPDATE HouseholdSubscriptions SET PaidThrough = ?',at(-89));
    await waitFor(()=>f.emails.length===2);
    assert.equal(f.pushes.length,1,'rejected device is not retried at the next milestone');
    api.execute('UPDATE HouseholdSubscriptions SET PaidThrough = ?',at(-91));
    await delay(1200); assert.equal(f.emails.length,2,'nothing is sent after the deletion deadline');
  } finally { await api.dispose(); await f.close(); }
});
