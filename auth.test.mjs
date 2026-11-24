import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('registration creates a durable account and an authenticated, revocable device session', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'family-budget-test-'));
  const dll = resolve('backend/FamilyBudget.Api/bin/Debug/net10.0/FamilyBudget.Api.dll');
  let server;
  let logs = '';
  const base = 'http://127.0.0.1:15087';
  const start = async () => {
    server = spawn('dotnet', [dll], { cwd: folder, env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Development', ASPNETCORE_URLS: base }, windowsHide: true });
    server.stdout.on('data', d => { logs += d; });
    server.stderr.on('data', d => { logs += d; });
    server.on('error', e => { logs += e.message; });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
      await delay(100);
    }
    throw new Error(`API did not start: ${logs}`);
  };
  const stop = async () => {
    if (server && server.exitCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill(); await exited;
    }
  };
  const call = (path, body, token) => fetch(`${base}/api/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const credentials = { email: 'Owner@example.com', password: 'correct horse battery staple' };
  try {
    await start();
    assert.equal((await call('me')).status, 401);
    assert.equal((await call('register', { email: 'invalid', password: credentials.password })).status, 400);
    assert.equal((await call('register', { ...credentials, password: 'short' })).status, 400);
    const response = await call('register', credentials);
    assert.equal(response.status, 201);
    const session = await response.json();
    assert.equal(session.user.email, credentials.email);
    assert.equal(typeof session.token, 'string');
    assert.ok(Date.parse(session.expiresAt) > Date.now());
    assert.equal((await call('me', undefined, session.token)).status, 200);
    assert.equal((await call('register', { ...credentials, email: ' owner@EXAMPLE.com ' })).status, 409);
    assert.equal((await call('login', { ...credentials, password: 'incorrect password' })).status, 401);
    assert.equal((await call('login', { ...credentials, email: 'unknown@example.com' })).status, 401);
    assert.equal((await call('me', undefined, 'forged-token')).status, 401);
    await stop();
    const database = await readFile(join(folder, 'data/budget.db'));
    assert.ok(!database.includes(Buffer.from(credentials.password)), 'password must not be stored as plaintext');
    assert.ok(!database.includes(Buffer.from(session.token)), 'session token must not be stored as plaintext');
    await start();
    assert.equal((await call('me', undefined, session.token)).status, 200, 'session survives API restart');
    const login = await call('login', { ...credentials, email: 'OWNER@example.com' });
    assert.equal(login.status, 200);
    const second = await login.json();
    assert.notEqual(second.token, session.token);
    assert.equal((await call('logout', {}, session.token)).status, 204);
    assert.equal((await call('me', undefined, session.token)).status, 401);
    assert.equal((await call('me', undefined, second.token)).status, 200, 'other device remains signed in');
    for (let i = 0; i < 10; i++) await call('login', { ...credentials, password: 'incorrect password' });
    assert.equal((await call('login', credentials)).status, 429);
  } catch (error) { console.error(logs); throw error; }
  finally { await stop(); await rm(folder, { recursive: true, force: true }); }
});
