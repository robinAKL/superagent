import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTH_ERROR, failureReason } from './agent-errors.mjs';

test('recognises sign-in failures of both CLIs, including an expired Claude Code session', () => {
  for (const text of [
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    'Not logged in · Please run /login',
    'Error: token has expired',
    '401 Unauthorized',
  ]) assert.ok(AUTH_ERROR.test(text), text);
  assert.ok(!AUTH_ERROR.test('ENOENT: no such file or directory'));
});

test('keeps the first line of a CLI failure and removes anything that looks like a credential', () => {
  assert.equal(failureReason('\n  Rate limit reached\nstack trace…'), 'Rate limit reached');
  assert.equal(failureReason('bad key sk-ant-abcdefghijklmnop used'), 'bad key [redacted] used');
  assert.equal(failureReason(''), '');
  assert.equal(failureReason('x'.repeat(500)).length, 300);
});
