import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from '../mobile/node_modules/typescript/lib/typescript.js';
import { resolveLanguage, categoryName } from '../mobile/src/categoryNames.ts';
import { authorNameFormat, bulgarian, translate, localizedMessage, localeFor, moneyFormat, dateFormat, monthFormat, dateInputFormat, dateInputParse } from '../mobile/src/localization.ts';
import { amountToMinor, validDate } from '../mobile/src/expense.ts';

test('Bulgarian device tags select Bulgarian, with English fallback for unsupported languages', () => {
  for (const tag of ['bg', 'bg-BG', 'BG_bg']) assert.equal(resolveLanguage(tag), 'bg');
  for (const tag of ['en', 'en-GB', 'de', null, undefined]) assert.equal(resolveLanguage(tag), 'en');
  assert.equal(localeFor('bg'), 'bg-BG'); assert.equal(localeFor('en'), 'en-US');
  assert.equal(categoryName('Groceries', 'bg'), 'Хранителни стоки');
  assert.equal(categoryName('Custom family label', 'bg'), 'Custom family label');
});

test('main interface copy and dynamic translations preserve family data and whitespace', () => {
  assert.equal(authorNameFormat('bg', '00000000-0000-0000-0000-000000000001', 'Former member'), 'Бивш член');
  assert.equal(authorNameFormat('bg', 'living-account', 'Former member'), 'Former member');
  assert.equal(translate('bg', 'Members'), 'Членове');
  assert.equal(translate('bg', 'Create your household'), 'Създайте домакинството си');
  assert.equal(translate('bg', 'Monthly summary'), 'Месечна справка');
  assert.equal(translate('bg', 'SHARED BUDGET · '), 'ОБЩ БЮДЖЕТ · ');
  assert.equal(translate('bg', 'Signed in as {0}', ['Maya@example.com']), 'Влезли сте като Maya@example.com');
  assert.equal(translate('en', 'Signed in as {0}', ['Maya@example.com']), 'Signed in as Maya@example.com');
  assert.equal(localizedMessage('bg', 'Email or password is incorrect.'), 'Имейлът или паролата са неправилни.');
  assert.match(localizedMessage('bg', 'Your household has reached its 3-member limit.'), /3/);
  assert.match(localizedMessage('bg', 'Your household has reached its 3-member limit.'), /Домакинството/);
  assert.equal(localizedMessage('bg', 'Unrecognized native failure'), 'Възникна грешка. Опитайте отново.');
  assert.equal(localizedMessage('en', 'Unrecognized native failure'), 'Unrecognized native failure');
});

test('EUR and USD follow selected language instead of system region', () => {
  for (const currency of ['EUR', 'USD']) {
    const bg = moneyFormat('bg', 123456, currency);
    assert.match(bg, /1[\s\u00a0\u202f]?234,56/);
    assert.match(moneyFormat('bg', -101, currency), /-1,01/);
    assert.match(moneyFormat('bg', 1234567, currency), /12[\s\u00a0\u202f]345,67/);
    assert.match(moneyFormat('en', 123456, currency), /1,234\.56/);
  }
});

test('dates and months are localized without shifting the transaction calendar date', () => {
  assert.match(dateFormat('bg', '2026-11-16'), /16\.11\.2026/);
  assert.equal(dateFormat('en', '2026-11-16'), '11/16/2026');
  assert.match(monthFormat('bg', '2026-11'), /ноември.*2026/);
  assert.equal(monthFormat('en', '2026-11'), 'November 2026');
  assert.match(dateFormat('bg', '2024-02-29'), /29\.02\.2024/);
});

test('Bulgarian date and decimal input round-trip to canonical API values', () => {
  assert.equal(dateInputFormat('bg', '2024-02-29'), '29.02.2024');
  assert.equal(dateInputParse('bg', '29.02.2024'), '2024-02-29');
  assert.equal(validDate(dateInputParse('bg', '29.02.2024')), true);
  assert.equal(validDate(dateInputParse('bg', '29.02.2025')), false);
  assert.equal(dateInputParse('bg', '16.11.'), '16.11.');
  assert.equal(dateInputFormat('en', '2026-11-16'), '2026-11-16');
  assert.equal(amountToMinor('1234,56'), 123456);
});

test('UI translation keys have Bulgarian entries and visible text is not left as English JSX', () => {
  const files = ['mobile/App.tsx', ...readdirSync('mobile/src', { recursive: true }).filter(f => f.endsWith('.tsx')).map(f => `mobile/src/${f}`), 'mobile/src/app/_layout.tsx'];
  const neutral = new Set(['you@example.com', '· #RRGGBB', '€  EUR', '$  USD', '(UTC).']);
  for (const file of files) {
    const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(tree) === 't' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const key = node.arguments[0].text;
        assert.ok(bulgarian[key] || bulgarian[key.trim()] || neutral.has(key.trim()), `${file}: missing ${key}`);
      }
      if (ts.isJsxText(node)) assert.ok(!/[A-Za-z]{3}/.test(node.text), `${file}: untranslated JSX ${node.text}`);
      if (ts.isJsxAttribute(node) && ['accessibilityLabel', 'placeholder'].includes(node.name.getText(tree)) && node.initializer && ts.isStringLiteral(node.initializer)) {
        assert.ok(!/[A-Za-z]{3}/.test(node.initializer.text), `${file}: untranslated attribute ${node.initializer.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
});
