import { expect, it } from 'vitest';
import { LINK_AGENTS } from '@superagent/shared';
import { CLIENT_LABEL, nextStep } from './LocalClients';

it('each local client gets the one step it needs next', () => {
  expect(nextStep({ agent: 'codex', state: 'missing', connected: false })).toBe('install');
  expect(nextStep({ agent: 'codex', state: 'signed-out', connected: false })).toBe('login');
  expect(nextStep({ agent: 'claude-code', state: 'ready', connected: false })).toBe('connect');
  expect(nextStep({ agent: 'claude-code', state: 'ready', connected: true })).toBe('more');
});

it('every supported client has a name and the same install, sign-in and connect steps', () => {
  expect(LINK_AGENTS).toEqual(['claude-code', 'codex', 'cursor', 'copilot', 'gemini', 'qwen']);
  for (const agent of LINK_AGENTS) {
    expect(CLIENT_LABEL[agent]).toBeTruthy();
    expect(nextStep({ agent, state: 'missing', connected: false })).toBe('install');
  }
});
