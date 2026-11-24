import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createApi } from './helpers/api.mjs';

const password = 'Family-budget-123!';
async function register(api, name) {
  const response = await api.call('auth/register', { email: `${name}@example.com`, password });
  assert.equal(response.status, 201);
  return response.json();
}
async function setup(api) {
  await api.start();
  const owner = await register(api, 'owner'), member = await register(api, 'member');
  const household = await (await api.call('households', { name: 'Family' }, owner.token)).json();
  const invite = await (await api.call('households/current/invites', {}, owner.token)).json();
  assert.equal((await api.call('invites/redeem', { code: invite.code }, member.token)).status, 200);
  return { owner, member, household, route: `households/${household.id}` };
}

test('one session scheme authenticates every feature with case-insensitive Bearer and case-sensitive tokens', async () => {
  const api = await createApi();
  try {
    const { owner, member, route } = await setup(api);
    const headers = { Authorization: `bEaReR ${owner.token}` };
    const checks = [
      ['auth/me', undefined, 200], ['households/current', undefined, 200],
      ['households/current/members', undefined, 200], ['households/current/export', undefined, 200],
      [`${route}/expense-categories`, undefined, 200], [`${route}/recurring`, undefined, 200],
      [`${route}/subscription`, undefined, 200],
      [`${route}/exchange-rate?currency=EUR&date=2024-01-01`, undefined, 400],
      [`${route}/base-currency/quote?currency=EUR`, undefined, 400],
      ['account/reminder-preferences', { language: 'en', pushAllowed: false }, 204],
      ['account/email-verification/confirm', { code: 'invalid' }, 400],
      ['account/data', { password }, 200],
      [`${route}/currency-notices/${randomUUID()}/dismiss`, {}, 403],
    ];
    for (const [path, body, status] of checks)
      assert.equal((await api.call(path, body, undefined, headers)).status, status, path);
    assert.equal((await api.call(`${route}/currency-notices/${randomUUID()}/dismiss`, {}, undefined,
      { Authorization: `bearer ${member.token}` })).status, 404);
    for (const header of ['Basic abc', 'Bearer', 'Bearer forged', `Bearer ${owner.token.toLowerCase()}`, `Bearer ${'a'.repeat(101)}`]) {
      const response = await api.call('auth/me', undefined, undefined, { Authorization: header });
      assert.equal(response.status, 401, header.slice(0, 10));
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
      assert.equal(response.headers.get('location'), null);
    }
    // The same device session is revoked regardless of scheme casing.
    assert.equal((await api.call('auth/logout', {}, undefined, headers)).status, 204);
    assert.equal((await api.call('auth/me', undefined, owner.token)).status, 401);
  } finally { await api.dispose(); }
});

test('protected feature groups challenge anonymous requests; public routes and repeated logout remain available', async () => {
  const api = await createApi();
  try {
    await api.start();
    const household = randomUUID();
    for (const [path, body] of [
      ['auth/me'], ['households/current'], ['households/current/export'], ['households', {}],
      ['households/current/invites', {}], [`households/${household}/expense-categories`],
      [`households/${household}/expenses`, {}], [`households/${household}/recurring`],
      [`households/${household}/subscription`], [`households/${household}/subscription/verify`, {}],
      [`households/${household}/exchange-rate?currency=USD&date=2024-01-01`],
      [`households/${household}/base-currency/confirm`, {}], ['account/data', {}],
      ['account/delete', {}], ['account/reminder-preferences', {}],
      ['account/email-verification/request', {}],
    ]) assert.equal((await api.call(path, body)).status, 401, path);
    assert.equal((await api.call('privacy-policy')).status, 200);
    assert.equal((await api.call('auth/logout', {})).status, 204);
    const session = await register(api, 'public');
    const login = await api.call('auth/login', { email: 'public@example.com', password }, 'forged');
    assert.equal(login.status, 200, 'invalid old credentials must not block a fresh sign-in');
    const hash = createHash('sha256').update(session.token).digest('hex').toUpperCase();
    api.execute("UPDATE Sessions SET ExpiresAt = '2000-01-01T00:00:00+00:00' WHERE TokenHash = ?", hash);
    assert.equal((await api.call('households/current', undefined, session.token)).status, 401);
    assert.equal((await api.call('auth/logout', {}, session.token)).status, 204);
  } finally { await api.dispose(); }
});

test('household roles are evaluated afresh for existing sessions and never grant cross-household access', async () => {
  const api = await createApi();
  try {
    const { owner, member, household, route } = await setup(api);
    const outsider = await register(api, 'outsider');
    const second = await (await api.call('households', { name: 'Other family' }, outsider.token)).json();
    assert.equal((await api.call('households/current/invites', {}, member.token)).status, 403);
    assert.equal((await api.call(`households/${second.id}/expense-categories`, undefined, owner.token)).status, 403);
    assert.equal((await api.call(`${route}/subscription/verify`, { store: 'APP_STORE', reference: 'fake' }, outsider.token)).status, 403);
    // Simulate committed ownership handover without issuing new session tokens.
    api.execute("UPDATE Memberships SET Role = CASE WHEN AccountId = ? THEN 'Owner' ELSE 'Member' END WHERE HouseholdId = ?",
      member.user.id.toUpperCase(), household.id.toUpperCase());
    assert.equal((await api.call('households/current/invites', {}, owner.token)).status, 403);
    assert.equal((await api.call('households/current/invites', {}, member.token)).status, 201);
    const before = api.query('SELECT COUNT(*) n FROM Invites')[0].n;
    api.execute('DELETE FROM Memberships WHERE AccountId = ?', owner.user.id.toUpperCase());
    assert.equal((await api.call(`${route}/expense-categories`, undefined, owner.token)).status, 403);
    assert.equal((await api.call('households/current/invites', {}, owner.token)).status, 403);
    assert.equal(api.query('SELECT COUNT(*) n FROM Invites')[0].n, before);
    assert.equal((await api.call('auth/me', undefined, owner.token)).status, 200);
  } finally { await api.dispose(); }
});
