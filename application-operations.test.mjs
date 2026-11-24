import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

test('shared money boundaries and application operations work without an HTTP context', async () => {
  const { stdout } = await promisify(execFile)('dotnet', [
    resolve('tests/FamilyBudget.SchedulerChecks/bin/Debug/net10.0/FamilyBudget.SchedulerChecks.dll'), 'application-checks',
  ], { windowsHide: true, timeout: 60000 });
  const result = JSON.parse(stdout.trim());
  assert.deepEqual(result, { moneyRules: true, explicitActorOperations: true, retrySafety: true, privacyAndReadOnly: true });
});
