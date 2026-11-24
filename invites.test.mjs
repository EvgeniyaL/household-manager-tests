import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApi } from './helpers/api.mjs';
import { inviteShareMessage } from '../mobile/src/invites.ts';

async function register(api, email) {
  const response = await api.call('auth/register', { email, password: 'correct horse battery staple' });
  assert.equal(response.status, 201);
  return response.json();
}
async function setup(api) {
  await api.start();
  const owner = await register(api, 'owner@example.com');
  assert.equal((await api.call('households', { name: 'Our family' }, owner.token)).status, 201);
  return owner;
}
async function issue(api, token) {
  const response = await api.call('households/current/invites', {}, token);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}
const digest = code => createHash('sha256').update(code.replaceAll('-', '').toUpperCase()).digest('hex').toUpperCase();

test('only an authenticated household owner can generate a hashed, shareable invite lasting exactly 48 hours', async () => {
  const api = await createApi();
  try {
    const owner = await setup(api);
    assert.equal((await api.call('households/current/invites', {})).status, 401);
    assert.equal((await api.call('households/current/members')).status, 401);
    const outsider = await register(api, 'outsider@example.com');
    assert.equal((await api.call('households/current/invites', {}, outsider.token)).status, 403);
    assert.equal((await api.call('households/current/members', undefined, outsider.token)).status, 404);
    const members = await (await api.call('households/current/members', undefined, owner.token)).json();
    assert.equal(members.householdName, 'Our family');
    assert.equal(members.canInvite, true);
    assert.equal(members.maxMembers, 4);
    assert.equal(members.members.length, 1);
    const invite = await issue(api, owner.token);
    assert.match(invite.code, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){7}$/);
    assert.equal(Date.parse(invite.expiresAt) - Date.parse(invite.createdAt), 48 * 60 * 60 * 1000);
    assert.ok(Math.abs(Date.now() - Date.parse(invite.createdAt)) < 5000);
    const [stored] = api.query('SELECT * FROM Invites');
    assert.equal(stored.CodeHash, digest(invite.code));
    assert.notEqual(stored.CodeHash, invite.code.replaceAll('-', ''));
    assert.equal(stored.CreatedByAccountId.toLowerCase(), owner.user.id);
    assert.equal(stored.ConsumedAt, null);
    const message = inviteShareMessage('Our family', invite);
    assert.ok(message.includes('Our family'));
    assert.ok(message.includes(invite.code));
    assert.ok(message.includes('once'));
    assert.ok(message.includes('expires'));
    await api.stop(); await api.start();
    const joined = await api.call('invites/redeem', { code: invite.code.toLowerCase() }, outsider.token);
    assert.equal(joined.status, 200, 'unconsumed code survives restart');
    const household = await joined.json();
    assert.equal(household.role, 'Member');
    assert.equal((await api.call('households/current/invites', {}, outsider.token)).status, 403);
    const listing = await (await api.call('households/current/members', undefined, outsider.token)).json();
    assert.equal(listing.canInvite, false);
    assert.equal(listing.members.length, 2);
    assert.equal(listing.role, 'Member');
  } finally { await api.dispose(); }
});

test('one invite admits only one account even under simultaneous redemption', async () => {
  const api = await createApi();
  try {
    const owner = await setup(api);
    const first = await register(api, 'first@example.com');
    const second = await register(api, 'second@example.com');
    const invite = await issue(api, owner.token);
    assert.equal((await api.call('invites/redeem', { code: invite.code })).status, 401);
    assert.equal((await api.call('invites/redeem', { code: invite.code }, owner.token)).status, 409);
    const responses = await Promise.all([first, second].map(member => api.call('invites/redeem', { code: invite.code }, member.token)));
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 410]);
    assert.equal(api.query('SELECT COUNT(*) AS count FROM Memberships')[0].count, 2);
    const [stored] = api.query('SELECT * FROM Invites');
    assert.ok(stored.ConsumedAt); assert.ok(stored.ConsumedByAccountId);
    await api.stop(); await api.start();
    const loser = responses[0].status === 410 ? first : second;
    assert.equal((await api.call('invites/redeem', { code: invite.code }, loser.token)).status, 410);
  } finally { await api.dispose(); }
});

test('expired and invalid codes cannot be redeemed and never add a member', async () => {
  const api = await createApi();
  try {
    const owner = await setup(api);
    const recipient = await register(api, 'recipient@example.com');
    const invite = await issue(api, owner.token);
    api.execute('UPDATE Invites SET ExpiresAt = ? WHERE CodeHash = ?', new Date(Date.now() - 1000).toISOString(), digest(invite.code));
    assert.equal((await api.call('invites/redeem', { code: invite.code }, recipient.token)).status, 410);
    assert.equal((await api.call('invites/redeem', { code: 'A'.repeat(32) }, recipient.token)).status, 410);
    for (const code of [null, '', 'short', 'Z'.repeat(32), 'A'.repeat(100)])
      assert.equal((await api.call('invites/redeem', { code }, recipient.token)).status, 400);
    assert.equal(api.query('SELECT COUNT(*) AS count FROM Memberships')[0].count, 1);
    assert.equal(api.query('SELECT ConsumedAt FROM Invites')[0].ConsumedAt, null);
  } finally { await api.dispose(); }
});

test('four-member capacity holds when different invites race for the last place', async () => {
  const api = await createApi();
  try {
    const owner = await setup(api);
    const recipients = [];
    for (let i = 0; i < 4; i++) recipients.push(await register(api, `member${i}@example.com`));
    for (const recipient of recipients.slice(0, 2)) {
      const invite = await issue(api, owner.token);
      assert.equal((await api.call('invites/redeem', { code: invite.code }, recipient.token)).status, 200);
    }
    const left = await issue(api, owner.token);
    const right = await issue(api, owner.token);
    const results = await Promise.all([
      api.call('invites/redeem', { code: left.code }, recipients[2].token),
      api.call('invites/redeem', { code: right.code }, recipients[3].token),
    ]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(api.query('SELECT COUNT(*) AS count FROM Memberships')[0].count, 4);
    assert.equal((await api.call('households/current/invites', {}, owner.token)).status, 409);
    const current = await (await api.call('households/current/members', undefined, owner.token)).json();
    assert.equal(current.canInvite, false);
    assert.equal(current.members.length, 4);
    assert.equal(api.query('SELECT COUNT(*) AS count FROM Invites WHERE ConsumedAt IS NULL')[0].count, 1, 'failed redemption does not consume its code');
  } finally { await api.dispose(); }
});
