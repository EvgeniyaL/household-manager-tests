import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApi } from './helpers/api.mjs';

async function register(api, email) {
  const response = await api.call('auth/register', { email, password: 'correct horse battery staple' });
  assert.equal(response.status, 201);
  return response.json();
}
async function invite(api, owner) {
  const response = await api.call('households/current/invites', {}, owner.token);
  assert.equal(response.status, 201);
  return response.json();
}
async function join(api, owner, member) {
  const code = await invite(api, owner);
  assert.equal((await api.call('invites/redeem', { code: code.code }, member.token)).status, 200);
}
async function setup(api) {
  await api.start();
  const owner = await register(api, 'owner@example.com');
  const created = await api.call('households', { name: 'Family' }, owner.token);
  assert.equal(created.status, 201);
  const household = await created.json();
  const member = await register(api, 'member@example.com');
  await join(api, owner, member);
  return { owner, member, household };
}
const remove = (api, household, owner, member) => api.call(`households/${household.id}/members/${member.user.id}/remove`, {}, owner?.token);
const leave = (api, household, member) => api.call(`households/${household.id}/leave`, {}, member?.token);
async function current(api, person) {
  const response = await api.call('households/current', undefined, person.token);
  assert.equal(response.status, 200);
  return (await response.json()).household;
}
function seedHistory(api, household, member) {
  api.execute('INSERT INTO Entries (Id, BudgetId, AuthorAccountId, AuthorName, AmountMinor, Description, OccurredOn) VALUES (?, ?, ?, ?, ?, ?, ?)',
    randomUUID().toUpperCase(), household.budget.id.toUpperCase(), member.user.id.toUpperCase(), 'Maya Taylor', -1299, 'Family groceries', '2026-01-02');
}

test('owner removal revokes every device immediately, frees a seat, and preserves named historical entries', async () => {
  const api = await createApi();
  try {
    const { owner, member, household } = await setup(api);
    const otherLogin = await api.call('auth/login', { email: 'member@example.com', password: 'correct horse battery staple' });
    assert.equal(otherLogin.status, 200);
    const otherDevice = await otherLogin.json();
    seedHistory(api, household, member);
    const before = await current(api, owner);
    assert.equal(before.budget.entries[0].authorName, 'Maya Taylor');
    assert.equal((await api.call('households/current/member-limit', { limit: 2 }, owner.token)).status, 200);
    const response = await remove(api, household, owner, member);
    assert.equal(response.status, 200);
    const members = await response.json();
    assert.equal(members.members.length, 1);
    assert.equal(members.maxMembers, 2);
    assert.equal(members.canInvite, true);
    for (const device of [member, otherDevice]) {
      assert.equal(await current(api, device), null);
      assert.equal((await api.call('households/current/members', undefined, device.token)).status, 404);
      assert.equal((await api.call('households/current/invites', {}, device.token)).status, 403);
      assert.equal((await api.call('households/current/member-limit', { limit: 4 }, device.token)).status, 403);
      assert.equal((await api.call('auth/me', undefined, device.token)).status, 200, 'account remains usable');
    }
    assert.deepEqual((await current(api, owner)).budget, before.budget);
    assert.equal(api.query('SELECT COUNT(*) AS count FROM Entries')[0].count, 1);
    const replacement = await register(api, 'replacement@example.com');
    await join(api, owner, replacement);
    assert.deepEqual((await current(api, replacement)).budget, before.budget);
    await api.stop(); await api.start();
    assert.equal(await current(api, member), null);
    assert.deepEqual((await current(api, owner)).budget, before.budget);
    assert.deepEqual(api.query('PRAGMA foreign_key_check'), []);
  } finally { await api.dispose(); }
});

test('members may leave, retain their account and attribution, and cannot affect a later household with an old leave request', async () => {
  const api = await createApi();
  try {
    const { owner, member, household } = await setup(api);
    seedHistory(api, household, member);
    const before = await current(api, owner);
    assert.equal((await leave(api, household, member)).status, 204);
    assert.equal((await leave(api, household, member)).status, 204, 'safe retry after a lost response');
    assert.equal(await current(api, member), null);
    assert.deepEqual((await current(api, owner)).budget, before.budget);
    const listing = await (await api.call('households/current/members', undefined, owner.token)).json();
    assert.equal(listing.members.length, 1);
    assert.equal(listing.canInvite, true);
    const created = await api.call('households', { name: 'New family' }, member.token);
    assert.equal(created.status, 201);
    const newHousehold = await created.json();
    assert.equal((await leave(api, household, member)).status, 204);
    assert.equal((await current(api, member)).id, newHousehold.id);
    assert.deepEqual((await current(api, owner)).budget, before.budget);
  } finally { await api.dispose(); }
});

test('removal requires the household owner, cannot target another household, and cannot remove or abandon the owner', async () => {
  const api = await createApi();
  try {
    const { owner, member, household } = await setup(api);
    const outsider = await register(api, 'outsider@example.com');
    assert.equal((await remove(api, household, null, member)).status, 401);
    assert.equal((await leave(api, household, null)).status, 401);
    assert.equal((await remove(api, household, member, owner)).status, 403);
    assert.equal((await remove(api, household, outsider, member)).status, 403);
    assert.equal((await remove(api, household, owner, outsider)).status, 404);
    assert.equal((await remove(api, household, owner, owner)).status, 409);
    assert.equal((await leave(api, household, owner)).status, 409);
    const other = await api.call('households', { name: 'Other household' }, outsider.token);
    assert.equal(other.status, 201);
    const otherHousehold = await other.json();
    assert.equal((await remove(api, otherHousehold, owner, outsider)).status, 403);
    assert.equal((await remove(api, household, outsider, member)).status, 403);
    assert.equal((await remove(api, household, owner, member)).status, 200);
    assert.equal((await remove(api, household, owner, member)).status, 404);
    assert.equal((await leave(api, household, owner)).status, 409, 'sole owner stays in the household');
    assert.equal((await current(api, owner)).role, 'Owner');
    assert.equal((await current(api, outsider)).id, otherHousehold.id);
  } finally { await api.dispose(); }
});

test('a join racing with departure uses the freed seat without exceeding the saved limit', async () => {
  const api = await createApi();
  try {
    const { owner, member, household } = await setup(api);
    const next = await register(api, 'next@example.com');
    const code = await invite(api, owner);
    assert.equal((await api.call('households/current/member-limit', { limit: 2 }, owner.token)).status, 200);
    const [left, joined] = await Promise.all([
      leave(api, household, member), api.call('invites/redeem', { code: code.code }, next.token),
    ]);
    assert.equal(left.status, 204);
    assert.ok([200, 409].includes(joined.status));
    if (joined.status === 409)
      assert.equal((await api.call('invites/redeem', { code: code.code }, next.token)).status, 200);
    const listing = await (await api.call('households/current/members', undefined, owner.token)).json();
    assert.equal(listing.members.length, 2);
    assert.equal(listing.maxMembers, 2);
    assert.ok(listing.members.some(m => m.id === next.user.id));
    assert.ok(!listing.members.some(m => m.id === member.user.id));
  } finally { await api.dispose(); }
});
