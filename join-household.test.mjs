import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from './helpers/api.mjs';
import { joinErrorMessage, normalizeInviteCode, validateInviteCode } from '../mobile/src/joinHousehold.ts';

test('join form accepts pasted codes without weakening invite validation', () => {
  const raw = 'abcdef0123456789abcdef0123456789';
  const pasted = `  ${raw.match(/.{4}/g).join(' - ')}\n`;
  assert.equal(normalizeInviteCode(pasted), raw.toUpperCase());
  assert.equal(validateInviteCode(pasted), null);
  assert.equal(validateInviteCode(raw), null);
  for (const input of ['', ' ', '1234', 'A'.repeat(31), 'A'.repeat(33), 'Z'.repeat(32)])
    assert.ok(validateInviteCode(input));
});

test('join errors explain expired codes and the saved household capacity', () => {
  assert.match(joinErrorMessage({ status: 410, message: 'Gone' }), /Ask your household owner for a new code/);
  assert.match(joinErrorMessage({ status: 409, message: 'Full', details: { code: 'member_limit_reached', limit: 2, planCap: 4 } }), /2-member limit.*raise the member limit/);
  const fullPlan = joinErrorMessage({ status: 409, message: 'Full', details: { code: 'member_limit_reached', limit: 4, planCap: 4 } });
  assert.match(fullPlan, /4-member limit.*remove a member/);
  assert.ok(!fullPlan.includes('raise'));
  assert.equal(joinErrorMessage({ message: 'Cannot reach the server.' }), 'Cannot reach the server.');
});

test('joining from a separate account opens the same shared budget and persists across devices', async t => {
  for (const currency of ['EUR', 'USD']) await t.test(currency, async () => {
    const api = await createApi();
    const password = 'correct horse battery staple';
    const register = async email => {
      const response = await api.call('auth/register', { email, password });
      assert.equal(response.status, 201);
      return response.json();
    };
    try {
      await api.start();
      const owner = await register('owner@example.com');
      const householdResponse = await api.call('households', { name: 'Family budget', baseCurrency: currency }, owner.token);
      assert.equal(householdResponse.status, 201);
      const original = await householdResponse.json();
      const recipient = await register('member@example.com');
      assert.notEqual(owner.token, recipient.token);
      const invited = await api.call('households/current/invites', {}, owner.token);
      assert.equal(invited.status, 201);
      const invite = await invited.json();
      const pasted = invite.code.toLowerCase().replaceAll('-', ' - ');
      const joined = await api.call('invites/redeem', { code: normalizeInviteCode(pasted) }, recipient.token);
      assert.equal(joined.status, 200);
      const memberBudget = await joined.json();
      assert.equal(memberBudget.role, 'Member');
      assert.equal(memberBudget.id, original.id);
      assert.equal(memberBudget.name, original.name);
      assert.equal(memberBudget.baseCurrency, currency);
      assert.deepEqual(memberBudget.budget, original.budget, 'member opens the existing budget');
      const current = await api.call('households/current', undefined, recipient.token);
      assert.equal(current.status, 200);
      assert.deepEqual((await current.json()).household, memberBudget);
      const ownerCurrent = await (await api.call('households/current', undefined, owner.token)).json();
      assert.equal(ownerCurrent.household.role, 'Owner');
      assert.equal((await api.call('invites/redeem', { code: invite.code }, recipient.token)).status, 409);
      assert.equal(api.query('SELECT COUNT(*) AS count FROM Households')[0].count, 1);
      assert.equal(api.query('SELECT COUNT(*) AS count FROM Budgets')[0].count, 1);
      assert.equal(api.query('SELECT COUNT(*) AS count FROM Memberships')[0].count, 2);
      await api.stop(); await api.start();
      const login = await api.call('auth/login', { email: 'member@example.com', password });
      assert.equal(login.status, 200);
      const anotherDevice = await login.json();
      assert.notEqual(anotherDevice.token, recipient.token);
      const restored = await api.call('households/current', undefined, anotherDevice.token);
      assert.equal(restored.status, 200);
      assert.deepEqual((await restored.json()).household, memberBudget);
    } finally { await api.dispose(); }
  });
});
