import { expect, it } from 'vitest';
import { nextStep } from './LocalClients';

it('each local client gets the one step it needs next', () => {
  expect(nextStep({ agent: 'codex', state: 'missing', connected: false })).toBe('install');
  expect(nextStep({ agent: 'codex', state: 'signed-out', connected: false })).toBe('login');
  expect(nextStep({ agent: 'claude-code', state: 'ready', connected: false })).toBe('connect');
  expect(nextStep({ agent: 'claude-code', state: 'ready', connected: true })).toBe('more');
});
