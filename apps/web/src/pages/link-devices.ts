import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

/** The newest Link for Windows; the release workflow keeps this address current (link-latest). */
export const LINK_INSTALLER_URL = 'https://github.com/robinAKL/superagent/releases/download/link-latest/SuperAgentLink-Setup-x64.exe';

export interface LinkProject {
  id: string;
  name: string;
  agent: 'codex' | 'claude-code';
}

export interface LinkBinding {
  employeeId: string;
  projectId: string;
}

export interface LinkDevice {
  id: string;
  name: string;
  kind: string;
  status: 'registered' | 'live' | 'waiting_auth' | 'offline' | 'revoked';
  capabilities: {
    agents?: string[];
    allowEmployees?: string[];
    allowProjects?: string[];
    projects?: LinkProject[];
    roomAssignments?: LinkBinding[];
  };
}

export function useLinkDevices() {
  const [devices, setDevices] = useState<LinkDevice[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await api<{ workers: LinkDevice[] }>('/api/v1/workers', { signal });
      if (response.status !== 200) throw new Error('workers_unavailable');
      if (signal?.aborted) return;
      setDevices(response.body.workers.filter(worker => worker.kind === 'link'));
      setUnavailable(false);
    } catch {
      if (!signal?.aborted) setUnavailable(true);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => { if (!document.hidden) void load(controller.signal); };
    void load(controller.signal);
    const timer = window.setInterval(refresh, 10_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  return { devices, unavailable, load };
}

export function agentLabel(agent: string) {
  return agent === 'claude-code' ? 'Claude Code' : agent === 'codex' ? 'Codex' : agent;
}

export function allowsBinding(device: LinkDevice, employeeId: string, projectId: string) {
  const { allowEmployees, allowProjects } = device.capabilities;
  return (!allowEmployees?.length || allowEmployees.includes(employeeId))
    && (!allowProjects?.length || allowProjects.includes(projectId));
}

export function getEmployeeLink(devices: LinkDevice[], employeeId: string) {
  const bindings = devices.filter(device => device.status !== 'revoked').flatMap(device =>
    (device.capabilities.roomAssignments ?? []).filter(binding => binding.employeeId === employeeId).map(binding => ({
      device, binding, project: device.capabilities.projects?.find(project => project.id === binding.projectId),
    })),
  );
  if (!bindings.length) return { status: 'unbound' } as const;
  if (bindings.length > 1) return { status: 'ambiguous' } as const;
  const { device, binding, project } = bindings[0]!;
  const status = !allowsBinding(device, employeeId, binding.projectId) ? 'restricted'
    : device.status === 'offline' ? 'offline'
    : device.status === 'waiting_auth' ? 'waitingAuth'
    : !project ? 'missingProject'
    : device.status === 'live' ? 'busy' : 'ready';
  return { status, device, project } as const;
}
