import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSetupState } from '../src/components/GettingStarted';

const ANSWERS: Record<string, unknown> = {
  '/api/v1/setup/llm': { status: 'configured' },
  '/api/v1/sop/company-context': { context: { name: 'INNOPRO' } },
  '/api/v1/knowledge/overview': { items: [{ confirmed: true }], analyses: [{ status: 'completed' }] },
  '/api/v1/knowledge/organization': { confirmation: null },
  '/api/v1/workers': { workers: [{ revokedAt: null, capabilities: { roomAssignments: [] } }] },
  '/api/v1/room/tasks?roomId=room-1': { tasks: [] },
};

function serve(overrides: Record<string, { status: number; body?: unknown }> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    const override = overrides[path];
    const status = override?.status ?? 200;
    return new Response(JSON.stringify(override?.body ?? ANSWERS[path] ?? {}), { status, headers: { 'content-type': 'application/json' } });
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('getting started', () => {
  it('reads each step from the API that owns it', async () => {
    serve();
    expect(await readSetupState()).toEqual({ model: true, company: true, knowledge: true, team: false, computer: false, result: false });
  });

  it('shows nothing rather than a wrong state when an answer cannot be read', async () => {
    serve({ '/api/v1/workers': { status: 500 } });
    expect(await readSetupState()).toBeNull();
  });
});
