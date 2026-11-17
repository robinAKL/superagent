import { PRESET_TOOL_CATALOG } from '../tools/catalog.js';
import type { ToolService } from '../tools/lifecycle.js';
import type { EmployeeService } from './employees.js';

/**
 * Turns a confirmed organization draft into registry entries (PRD §3.3 "组织草案：草稿 → 已确认").
 * Every id is derived from the recommendation id, so confirming twice — or a retried transaction — never creates a
 * second team. Creating an employee grants no runtime, tool or account; a missing capability becomes a tool placeholder.
 */
export interface OrganizationSink {
  ensureEmployee(input: { recId: string; name: string; duty: string; prompt: string; owner: string; manual: boolean }): { employeeId: string; created: boolean };
  /** An already-available capability this tool draft can reuse, if any. */
  matchTool(name: string, description: string): { toolId: string; name: string } | null;
  ensureToolPlaceholder(input: { recId: string; name: string; purpose: string; consumers: string[]; maintainer: string }): { toolId: string; created: boolean };
  /** Whether an id recorded at confirmation still exists in this process (false after a restart until re-applied). */
  present(kind: 'employee' | 'tool', id: string): boolean;
  /** Removes an employee whose role left the organization; false (kept) while it still has active work. */
  retireEmployee?(employeeId: string): boolean;
  /** Every employee an organization confirmation created (id prefix emp-org-), whatever record still points at it. */
  organizationEmployees?(): { id: string; name: string }[];
}

export const orgEmployeeId = (recId: string) => `emp-org-${recId}`;
export const orgToolId = (recId: string) => `tool-org-${recId}`;

const norm = (s: string) => s.toLowerCase().replace(/[\s\-_·.,，。、/()（）]+/g, '');

export function createOrganizationSink(employees: () => EmployeeService, tools: () => ToolService): OrganizationSink {
  return {
    ensureEmployee({ recId, name, duty, prompt, owner, manual }) {
      const { employee, created } = employees().ensure({ id: orgEmployeeId(recId), name, duty, prompt, owner, source: manual ? 'manual' : 'recommended' });
      return { employeeId: employee.id, created };
    },
    matchTool(name, description) {
      const text = norm(`${name} ${description}`), title = norm(name);
      const hit = PRESET_TOOL_CATALOG.find(p => p.installable && [p.name.zh, p.name.en, p.toolId].some(n => {
        const key = norm(n);
        return key.length >= 2 && (text.includes(key) || (title.length >= 2 && key.includes(title)));
      }));
      return hit ? { toolId: hit.toolId, name: hit.name.zh } : null;
    },
    ensureToolPlaceholder({ recId, name, purpose, consumers, maintainer }) {
      const svc = tools(), toolId = orgToolId(recId);
      try { svc.get(toolId); return { toolId, created: false }; } catch { /* not created yet */ }
      svc.createPlaceholder({
        name, consumers, maintainer, acceptanceCases: [],
        contract: { toolId, action: toolId, purpose: purpose.slice(0, 1000), targetSystem: 'to-be-decided', effect: 'read', input: { type: 'object' }, output: { type: 'object' }, risk: 'low', requiresExactApproval: false },
      });
      return { toolId, created: true };
    },
    retireEmployee(employeeId) {
      const svc = employees();
      if (!svc.has(employeeId)) return true;
      try { svc.remove(employeeId); return true; } catch { return false; }
    },
    organizationEmployees() {
      return employees().list().filter(e => e.id.startsWith('emp-org-')).map(e => ({ id: e.id, name: e.name }));
    },
    present(kind, id) {
      if (kind === 'employee') return employees().has(id);
      try { tools().get(id); return true; } catch { return false; }
    },
  };
}
