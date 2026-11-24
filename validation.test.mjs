import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CURRENCY, validate, validateHousehold } from '../mobile/src/validation.ts';

test('mobile validation rejects missing fields and accepts a valid registration', () => {
  assert.ok(validate('', 'a sufficiently long password'));
  assert.ok(validate('owner@', 'a sufficiently long password'));
  assert.ok(validate('owner@example.com', 'short'));
  assert.ok(validate('owner@example.com', 'x'.repeat(129)));
  assert.equal(validate(' owner@example.com ', 'a sufficiently long password'), null);
});

test('household form defaults to EUR and accepts only named EUR or USD households', () => {
  assert.equal(DEFAULT_CURRENCY, 'EUR');
  assert.ok(validateHousehold('', 'EUR'));
  assert.ok(validateHousehold('   ', 'EUR'));
  assert.ok(validateHousehold('x'.repeat(81), 'EUR'));
  assert.ok(validateHousehold('Family', 'GBP'));
  assert.equal(validateHousehold(' Family ', 'EUR'), null);
  assert.equal(validateHousehold('x'.repeat(80), 'USD'), null);
});
