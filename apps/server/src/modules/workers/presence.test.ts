import { expect, it } from 'vitest';
import { linkMayBeOnline, linkOnline, markLinkPresence, resetLinkPresence } from './presence.js';
import { OFFLINE_AFTER_MS } from './registry.js';

it('an employee is online while a bound computer keeps sending heartbeats', () => {
  resetLinkPresence(1_000);
  expect(linkOnline('emp-a', 1_000)).toBe(false);
  markLinkPresence(['emp-a'], 2_000);
  expect(linkOnline('emp-a', 2_000 + OFFLINE_AFTER_MS)).toBe(true);
  expect(linkOnline('emp-a', 2_001 + OFFLINE_AFTER_MS)).toBe(false);
});

it('right after a restart, an employee not seen yet may still be online for one offline window', () => {
  resetLinkPresence(10_000);
  expect(linkMayBeOnline('emp-b', 10_000 + OFFLINE_AFTER_MS - 1)).toBe(true);
  expect(linkMayBeOnline('emp-b', 10_000 + OFFLINE_AFTER_MS)).toBe(false);
  // Seen and then gone quiet: disconnected, grace or not.
  markLinkPresence(['emp-c'], 10_000);
  expect(linkMayBeOnline('emp-c', 10_001 + OFFLINE_AFTER_MS)).toBe(false);
});
