import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memberLimitNotice, prepareMemberInvite } from '../mobile/src/memberCapacity.ts';
import { createApi } from './helpers/api.mjs';

test('tapping invite at 4 of 4 reports the limit without calling invite creation', async () => {
  let created = 0;
  const result = await prepareMemberInvite(
    async () => ({ maxMembers: 4, planCap: 4, members: [1, 2, 3, 4] }),
    async () => { created++; return { code: 'must-not-be-created' }; },
  );
  assert.equal(result.kind, 'blocked');
  assert.equal(created, 0);
  const notice = memberLimitNotice(result.members.maxMembers, result.members.planCap);
  assert.match(notice.message, /4-member limit/);
  assert.match(notice.message, /No invite was created/);
  assert.equal(notice.canRaise, false);
});

test('a lower household limit offers the raise shortcut and uses refreshed capacity', async () => {
  let created = 0;
  const result = await prepareMemberInvite(
    async () => ({ maxMembers: 2, planCap: 4, members: [1, 2] }),
    async () => { created++; },
  );
  assert.equal(result.kind, 'blocked');
  assert.equal(created, 0);
  const notice = memberLimitNotice(result.members.maxMembers, result.members.planCap);
  assert.match(notice.message, /2-member limit/);
  assert.match(notice.message, /Raise the member limit/);
  assert.equal(notice.canRaise, true);
});

test('available capacity generates once and failed refresh never creates an invite', async () => {
  let created = 0;
  const create = async () => { created++; return { code: 'one-code' }; };
  const result = await prepareMemberInvite(async () => ({ maxMembers: 3, planCap: 4, members: [1, 2] }), create);
  assert.equal(result.kind, 'created');
  assert.equal(result.invite.code, 'one-code');
  assert.equal(created, 1);
  await assert.rejects(prepareMemberInvite(async () => { throw new Error('offline'); }, create), /offline/);
  assert.equal(created, 1);
});

test('server blocks invite creation at every current limit and reports capacity on redemption', async () => {
  const api = await createApi();
  try {
    await api.start();
    const register = async email => {
      const response = await api.call('auth/register', { email, password: 'correct horse battery staple' });
      assert.equal(response.status, 201);
      return response.json();
    };
    const owner = await register('owner@example.com');
    assert.equal((await api.call('households', { name: 'Family' }, owner.token)).status, 201);
    const recipients = [];
    for (let i = 0; i < 4; i++) recipients.push(await register(`member${i}@example.com`));
    const initial = await api.call('households/current/invites', {}, owner.token);
    assert.equal(initial.status, 201);
    const oldCode = await initial.json();
    for (let limit = 1; limit <= 4; limit++) {
      assert.equal((await api.call('households/current/member-limit', { limit }, owner.token)).status, 200);
      if (limit > 1) {
        const issued = await api.call('households/current/invites', {}, owner.token);
        assert.equal(issued.status, 201);
        const invite = await issued.json();
        assert.equal((await api.call('invites/redeem', { code: invite.code }, recipients[limit - 2].token)).status, 200);
      }
      const before = api.query('SELECT COUNT(*) AS count FROM Invites')[0].count;
      const blocked = await api.call('households/current/invites', {}, owner.token);
      assert.equal(blocked.status, 409);
      const details = await blocked.json();
      assert.equal(details.code, 'member_limit_reached');
      assert.equal(details.limit, limit);
      assert.equal(details.planCap, 4);
      assert.equal(details.memberCount, limit);
      assert.match(details.message, new RegExp(`${limit}-member limit`));
      assert.equal(api.query('SELECT COUNT(*) AS count FROM Invites')[0].count, before, 'blocked request inserts no invite');
      const redemption = await api.call('invites/redeem', { code: oldCode.code }, recipients[3].token);
      assert.equal(redemption.status, 409);
      assert.deepEqual(await redemption.json(), details, 'generation and redemption report the same capacity');
    }
    assert.equal(api.query('SELECT COUNT(*) AS count FROM Memberships')[0].count, 4);
  } finally { await api.dispose(); }
});
