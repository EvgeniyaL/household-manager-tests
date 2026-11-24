import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApi } from './helpers/api.mjs';

test('job clock, bounded paging, retry/restart, shutdown and safe diagnostics are deterministic', async () => {
  const { stdout } = await promisify(execFile)('dotnet', [resolve('tests/FamilyBudget.SchedulerChecks/bin/Debug/net10.0/FamilyBudget.SchedulerChecks.dll'), 'job-checks'], { windowsHide: true, timeout: 60000 });
  assert.deepEqual(JSON.parse(stdout.trim()), { clockBoundaries: true, paging: true, retryAndRestart: true, cancellation: true, safeDiagnostics: true });
});

test('invalid typed settings fail startup before creating a database and never echo credentials', async () => {
  for (const env of [
    { Retention__TrialDays: '0' }, { Recurring__BatchSize: '0' }, { BaseCurrency__PollSeconds: '0' },
    { CurrencyNotifications__BatchSize: '1001' }, { ExchangeRates__BaseUrl: 'http://example.com/' },
    { Reminders__Resend__Enabled: 'true' },
    { Billing__Apple__Enabled: 'true', Billing__Apple__PrivateKeyPem: 'secret-do-not-log' },
    { Billing__Google__ClientEmail: 'partial@example.com' }, { Billing__TrialDays: '0' },
  ]) {
    const api = await createApi({ env });
    try {
      await assert.rejects(api.start(), error => /settings|credentials/.test(error.message) && !error.message.includes('secret-do-not-log'));
      assert.equal(existsSync(api.databasePath), false);
    } finally { await api.dispose(); }
  }
});

test('optional store and email integrations can be explicitly disabled without blocking manual budgets', async () => {
  const api = await createApi({ env: { Billing__Apple__Enabled: 'false', Billing__Apple__PrivateKeyPem: 'disabled', Reminders__Resend__Enabled: 'false', Reminders__Resend__ApiKey: 'disabled' } });
  try {
    await api.start();
    const owner = await (await api.call('auth/register', { email: 'owner@example.com', password: 'Family-budget-123!' })).json();
    const response = await api.call('households', { name: 'Family' }, owner.token);
    assert.equal(response.status, 201);
    const household = await response.json();
    const status = await (await api.call(`households/${household.id}/subscription?store=APP_STORE`, undefined, owner.token)).json();
    assert.equal(status.subscription.billingAvailable, false);
    assert.equal((await api.call('account/email-verification/request', {}, owner.token)).status, 503);
  } finally { await api.dispose(); }
});
