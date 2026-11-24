import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from './helpers/api.mjs';

async function account(api, email) {
  const response = await api.call('auth/register', { email, password: 'correct horse battery staple' });
  assert.equal(response.status, 201);
  return response.json();
}
async function setup(api) {
  await api.start();
  const owner = await account(api, 'owner@example.com');
  assert.equal((await api.call('households', { name: 'Our family' }, owner.token)).status, 201);
  return owner;
}
async function invite(api, owner) {
  const response = await api.call('households/current/invites', {}, owner.token);
  assert.equal(response.status, 201);
  return response.json();
}
async function join(api, owner, recipient) {
  const code = await invite(api, owner);
  assert.equal((await api.call('invites/redeem', { code: code.code }, recipient.token)).status, 200);
}
async function members(api, owner) {
  const response = await api.call('households/current/members', undefined, owner.token);
  assert.equal(response.status, 200);
  return response.json();
}
const save = (api, owner, limit) => api.call('households/current/member-limit', { limit }, owner.token);

test('upgrading a US-03 household defaults to 4 while preserving its budget, owner, session, and pending code', async () => {
  const api = await createApi({ legacy: true, legacyHousehold: true });
  try {
    await api.start();
    const owner = api.legacyAccount;
    const current = await members(api, owner);
    assert.equal(current.householdName, 'Existing family');
    assert.equal(current.maxMembers, 4);
    assert.equal(current.planCap, 4);
    assert.equal(current.members.length, 1);
    assert.equal(api.query('SELECT COUNT(*) AS count FROM Budgets')[0].count, 1);
    const recipient = await account(api, 'recipient@example.com');
    assert.equal((await api.call('invites/redeem', { code: 'B'.repeat(32) }, recipient.token)).status, 200);
    assert.equal((await members(api, owner)).members.length, 2);
    assert.deepEqual(api.query('PRAGMA foreign_key_check'), []);
  } finally { await api.dispose(); }
});

test('with two members, saving 3 persists the limit and admits exactly one more person', async () => {
  const api = await createApi();
  try {
    const owner = await setup(api);
    const second = await account(api, 'second@example.com');
    await join(api, owner, second);
    const defaults = await members(api, owner);
    assert.equal(defaults.maxMembers, 4);
    assert.equal(defaults.planCap, 4);
    const response = await save(api, owner, 3);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.maxMembers, 3);
    assert.equal(result.members.length, 2);
    assert.equal(result.canInvite, true);
    assert.equal(result.maxMembers - result.members.length, 1);
    assert.equal(api.query('SELECT MemberLimit FROM Households')[0].MemberLimit, 3);
    await api.stop(); await api.start();
    assert.equal((await members(api, owner)).maxMembers, 3);
    const third = await account(api, 'third@example.com');
    const fourth = await account(api, 'fourth@example.com');
    const lastPlace = await invite(api, owner);
    const pending = await invite(api, owner);
    assert.equal((await api.call('invites/redeem', { code: lastPlace.code }, third.token)).status, 200);
    assert.equal((await members(api, owner)).canInvite, false);
    assert.equal((await api.call('households/current/invites', {}, owner.token)).status, 409);
    assert.equal((await api.call('invites/redeem', { code: pending.code }, fourth.token)).status, 409);
    assert.equal((await save(api, owner, 4)).status, 200);
    assert.equal((await api.call('invites/redeem', { code: pending.code }, fourth.token)).status, 200, 'blocked code is not consumed');
    assert.equal((await members(api, owner)).members.length, 4);
  } finally { await api.dispose(); }
});

test('only owners can save whole-number limits in range, never below current membership', async () => {
  const api = await createApi();
  try {
    const owner = await setup(api);
    const second = await account(api, 'second@example.com');
    const outsider = await account(api, 'outsider@example.com');
    await join(api, owner, second);
    assert.equal((await api.call('households/current/member-limit', { limit: 3 })).status, 401);
    assert.equal((await save(api, outsider, 3)).status, 403);
    assert.equal((await save(api, second, 3)).status, 403);
    for (const input of [{}, { limit: null }, { limit: 0 }, { limit: -1 }, { limit: 5 }, { limit: 1.5 }, { limit: 'three' }, { limit: true }])
      assert.equal((await api.call('households/current/member-limit', input, owner.token)).status, 400, JSON.stringify(input));
    const lower = await save(api, owner, 1);
    assert.equal(lower.status, 409);
    assert.match((await lower.json()).message, /Remove a member/);
    assert.equal((await members(api, owner)).maxMembers, 4);
    assert.equal((await save(api, owner, 2)).status, 200, 'current member count is allowed');
    assert.equal((await save(api, owner, 2)).status, 200, 'saving an unchanged limit is allowed');
    const current = await members(api, owner);
    assert.equal(current.members.length, 2, 'lowering a limit never removes members');
    assert.equal(current.maxMembers, 2);
    assert.equal(current.canInvite, false);
    assert.equal(current.planCap, 4);
  } finally { await api.dispose(); }
});

test('a limit of 1 blocks both new invites and redemption of codes issued earlier', async () => {
  const api = await createApi();
  try {
    const owner = await setup(api);
    const recipient = await account(api, 'recipient@example.com');
    const code = await invite(api, owner);
    assert.equal((await save(api, owner, 1)).status, 200);
    assert.equal((await api.call('households/current/invites', {}, owner.token)).status, 409);
    assert.equal((await api.call('invites/redeem', { code: code.code }, recipient.token)).status, 409);
    assert.equal((await members(api, owner)).members.length, 1);
    assert.equal(api.query('SELECT ConsumedAt FROM Invites')[0].ConsumedAt, null);
    assert.equal((await save(api, owner, 2)).status, 200);
    assert.equal((await api.call('invites/redeem', { code: code.code }, recipient.token)).status, 200);
  } finally { await api.dispose(); }
});

test('joining and reducing the limit concurrently always preserve membership <= limit', async () => {
  const api = await createApi();
  try {
    const owner = await setup(api);
    const second = await account(api, 'second@example.com');
    await join(api, owner, second);
    const recipient = await account(api, 'recipient@example.com');
    const code = await invite(api, owner);
    const [limitResult, joinResult] = await Promise.all([
      save(api, owner, 2), api.call('invites/redeem', { code: code.code }, recipient.token),
    ]);
    const current = await members(api, owner);
    assert.ok(current.members.length <= current.maxMembers);
    if (limitResult.status === 200) {
      assert.equal(joinResult.status, 409);
      assert.equal(current.maxMembers, 2);
      assert.equal(current.members.length, 2);
    } else {
      assert.equal(limitResult.status, 409);
      assert.equal(joinResult.status, 200);
      assert.equal(current.maxMembers, 4);
      assert.equal(current.members.length, 3);
    }
  } finally { await api.dispose(); }
});
