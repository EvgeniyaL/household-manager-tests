import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

export async function createApi({ legacy = false, legacyHousehold = false, env = {} } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'family-household-test-'));
  const databasePath = join(folder, 'data/budget.db');
  const legacyAccount = { id: randomUUID().toUpperCase(), email: 'legacy@example.com', token: 'legacy-session-token' };
  if (legacy) {
    await mkdir(join(folder, 'data'));
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE Accounts (Id TEXT NOT NULL PRIMARY KEY, Email TEXT NOT NULL, NormalizedEmail TEXT NOT NULL, PasswordHash TEXT NOT NULL);
      CREATE UNIQUE INDEX IX_Accounts_NormalizedEmail ON Accounts (NormalizedEmail);
      CREATE TABLE Sessions (TokenHash TEXT NOT NULL PRIMARY KEY, AccountId TEXT NOT NULL REFERENCES Accounts(Id) ON DELETE CASCADE, ExpiresAt TEXT NOT NULL);
      CREATE INDEX IX_Sessions_AccountId ON Sessions (AccountId);
    `);
    db.prepare('INSERT INTO Accounts VALUES (?, ?, ?, ?)').run(legacyAccount.id, legacyAccount.email, legacyAccount.email.toUpperCase(), 'preserved-password-hash');
    db.prepare('INSERT INTO Sessions VALUES (?, ?, ?)').run(createHash('sha256').update(legacyAccount.token).digest('hex').toUpperCase(), legacyAccount.id, new Date(Date.now() + 86400000).toISOString());
    if (legacyHousehold) {
      // Exact pre-US-04 table shape: intentionally has no MemberLimit column.
      db.exec(`
        CREATE TABLE Households (Id TEXT NOT NULL PRIMARY KEY, Name TEXT NOT NULL, BaseCurrency TEXT NOT NULL,
          CONSTRAINT CK_Household_Currency CHECK (BaseCurrency IN ('EUR', 'USD')),
          CONSTRAINT CK_Household_Name CHECK (length(trim(Name)) BETWEEN 1 AND 80));
        CREATE TABLE Budgets (Id TEXT NOT NULL PRIMARY KEY, HouseholdId TEXT NOT NULL REFERENCES Households(Id) ON DELETE CASCADE);
        CREATE UNIQUE INDEX IX_Budgets_HouseholdId ON Budgets (HouseholdId);
        CREATE TABLE Memberships (AccountId TEXT NOT NULL PRIMARY KEY REFERENCES Accounts(Id) ON DELETE CASCADE,
          HouseholdId TEXT NOT NULL REFERENCES Households(Id) ON DELETE CASCADE,
          Role TEXT NOT NULL CHECK (Role IN ('Owner', 'Member')));
        CREATE INDEX IX_Memberships_HouseholdId ON Memberships (HouseholdId);
        CREATE TABLE Invites (CodeHash TEXT NOT NULL PRIMARY KEY, HouseholdId TEXT NOT NULL REFERENCES Households(Id) ON DELETE CASCADE,
          CreatedByAccountId TEXT NOT NULL REFERENCES Accounts(Id) ON DELETE RESTRICT, CreatedAt TEXT NOT NULL, ExpiresAt TEXT NOT NULL,
          ConsumedAt TEXT NULL, ConsumedByAccountId TEXT NULL REFERENCES Accounts(Id) ON DELETE RESTRICT);
        CREATE INDEX IX_Invites_HouseholdId ON Invites (HouseholdId);
        CREATE INDEX IX_Invites_CreatedByAccountId ON Invites (CreatedByAccountId);
        CREATE INDEX IX_Invites_ConsumedByAccountId ON Invites (ConsumedByAccountId);
        CREATE TABLE __EFMigrationsHistory (MigrationId TEXT NOT NULL PRIMARY KEY, ProductVersion TEXT NOT NULL);
        INSERT INTO __EFMigrationsHistory VALUES
          ('20261116073635_InitialAccounts', '10.0.14'),
          ('20261116073753_AddHouseholds', '10.0.14'),
          ('20261116074703_AddHouseholdInvites', '10.0.14');
      `);
      const householdId = randomUUID().toUpperCase();
      db.prepare('INSERT INTO Households VALUES (?, ?, ?)').run(householdId, 'Existing family', 'USD');
      db.prepare('INSERT INTO Budgets VALUES (?, ?)').run(randomUUID().toUpperCase(), householdId);
      db.prepare('INSERT INTO Memberships VALUES (?, ?, ?)').run(legacyAccount.id, householdId, 'Owner');
      db.prepare('INSERT INTO Invites VALUES (?, ?, ?, ?, ?, NULL, NULL)').run(
        createHash('sha256').update('B'.repeat(32)).digest('hex').toUpperCase(), householdId, legacyAccount.id,
        new Date().toISOString(), new Date(Date.now() + 48 * 3600000).toISOString());
    }
    db.close();
  }
  let server;
  let base;
  let logs = '';
  const dll = resolve('backend/FamilyBudget.Api/bin/Debug/net10.0/FamilyBudget.Api.dll');
  async function start(overrides = {}) {
    base = undefined;
    server = spawn('dotnet', [dll], { cwd: folder, env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Development', ASPNETCORE_URLS: 'http://127.0.0.1:0', Recurring__Enabled: 'false', Retention__Enabled: 'false', Reminders__Enabled: 'false', ExchangeRates__DailyEnabled:'false', BaseCurrency__Enabled:'false', CurrencyNotifications__Enabled:'false', ...env, ...overrides }, windowsHide: true });
    server.stdout.on('data', data => {
      logs += data;
      const match = logs.match(/Now listening on: (http:\/\/127\.0\.0\.1:\d+)/g)?.at(-1);
      if (match) base = match.replace('Now listening on: ', '');
    });
    server.stderr.on('data', data => { logs += data; });
    server.on('error', error => { logs += error.message; });
    for (let i = 0; i < 150; i++) {
      try { if (base && (await fetch(`${base}/health`)).ok) return; } catch {}
      if (server.exitCode !== null) break;
      await delay(100);
    }
    throw new Error(`API failed to start: ${logs}`);
  }
  async function stop() {
    if (server && server.exitCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill(); await exited;
    }
  }
  const replicas = [];
  async function startReplica(overrides = {}) {
    const process = spawn('dotnet', [dll], { cwd: folder, env: { ...globalThis.process.env, ASPNETCORE_ENVIRONMENT: 'Development', ASPNETCORE_URLS: 'http://127.0.0.1:0', Recurring__Enabled: 'true', Recurring__PollSeconds: '1', Retention__Enabled: 'false', Reminders__Enabled: 'false', ExchangeRates__DailyEnabled:'false', BaseCurrency__Enabled:'false', CurrencyNotifications__Enabled:'false', ...env, ...overrides }, windowsHide: true });
    replicas.push(process);
    let replicaBase;
    process.stdout.on('data', data => { const match = String(data).match(/Now listening on: (http:\/\/127\.0\.0\.1:\d+)/); if (match) replicaBase = match[1]; });
    process.stderr.on('data', () => {});
    for (let i = 0; i < 150; i++) {
      try { if (replicaBase && (await fetch(`${replicaBase}/health`)).ok) return; } catch {}
      await delay(100);
    }
    throw new Error('Replica failed to start');
  }
  return {
    start, stop, startReplica, legacyAccount, databasePath,
    logs: () => logs,
    async dispose() { for (const replica of replicas) if (replica.exitCode === null) { const exited = new Promise(resolve => replica.once('exit', resolve)); replica.kill(); await exited; } await stop(); await rm(folder, { recursive: true, force: true }); },
    call(path, body, token, headers = {}) {
      return fetch(`${base}/api/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', Connection: 'close', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
    query(sql) {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try { return db.prepare(sql).all(); } finally { db.close(); }
    },
    execute(sql, ...parameters) {
      const db = new DatabaseSync(databasePath);
      try { db.exec('PRAGMA busy_timeout = 5000'); return db.prepare(sql).run(...parameters); } finally { db.close(); }
    },
  };
}
