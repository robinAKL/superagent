/**
 * "Team size": re-plan the role drafts into exactly N roles (PRD §3.3 human adjustment, at organization scale).
 * Every proposed role names the current roles it comes from, so the owner can see what was merged or split, and
 * together the proposal must still cover every tool and workflow the current roles were responsible for.
 */
export interface PlanSourceRole { id: string; name: string; duty: string; tools: string[]; sops: string[]; edited: boolean }
export interface PlanRole { name: string; duty: string; tools: string[]; sops: string[]; from: string[] }
export interface TeamPlan {
  id: string; target: number; method: 'model' | 'merge'; createdAt: string; createdBy: string;
  /** Sorted ids of the roles the plan was made from; a plan is only adoptable while these are still the roles. */
  basis: string[];
  roles: PlanRole[];
}
export const TEAM_SIZE_MAX = 20;

export class TeamPlanError extends Error { constructor(public code: string) { super(code); } }

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
const keyList = (v: unknown, known: Set<string>) =>
  Array.isArray(v) ? [...new Set(v.filter((k): k is string => typeof k === 'string' && known.has(k)))] : null;

/** Validates a model's proposal: exact count, known keys, every source role used, every duty still covered. */
export function validateTeamPlan(value: unknown, input: { target: number; roles: PlanSourceRole[]; toolKeys: string[]; sopKeys: string[] }): PlanRole[] {
  if (!Array.isArray(value) || value.length !== input.target) throw new TeamPlanError('plan_wrong_size');
  const ids = new Set(input.roles.map(r => r.id)), tools = new Set(input.toolKeys), sops = new Set(input.sopKeys);
  const roles = value.map(v => {
    const p = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const name = str(p.name, 160), duty = str(p.duty, 4000), t = keyList(p.tools, tools), s = keyList(p.sops, sops), from = keyList(p.from, ids);
    if (!name || !duty || !t || !s || !from?.length) throw new TeamPlanError('plan_invalid_role');
    return { name, duty, tools: t, sops: s, from };
  });
  if (new Set(roles.map(r => r.name)).size !== roles.length) throw new TeamPlanError('plan_duplicate_names');
  const used = new Set(roles.flatMap(r => r.from));
  if (input.roles.some(r => !used.has(r.id))) throw new TeamPlanError('plan_drops_role');
  const coveredTools = new Set(roles.flatMap(r => r.tools)), coveredSops = new Set(roles.flatMap(r => r.sops));
  for (const r of input.roles) {
    if (r.tools.some(k => !coveredTools.has(k)) || r.sops.some(k => !coveredSops.has(k))) throw new TeamPlanError('plan_drops_work');
  }
  return roles;
}

const overlap = (a: PlanRole, b: PlanRole) => {
  const x = new Set([...a.tools.map(k => `t:${k}`), ...a.sops.map(k => `s:${k}`)]);
  const y = new Set([...b.tools.map(k => `t:${k}`), ...b.sops.map(k => `s:${k}`)]);
  const inter = [...x].filter(k => y.has(k)).length, union = new Set([...x, ...y]).size;
  return union ? inter / union : 0;
};

/**
 * Model-free fallback for shrinking a team: repeatedly merge the two roles that share the most tools and workflows
 * (ties: the pair with the fewest source roles, then list order). Never invents work; it can only merge.
 */
export function mergeByOverlap(roles: PlanSourceRole[], target: number, labels: { join: string; more: (first: string, n: number) => string }): PlanRole[] {
  if (target < 1 || target >= roles.length) throw new TeamPlanError('merge_needs_fewer');
  let groups: PlanRole[] = roles.map(r => ({ name: r.name, duty: r.duty, tools: [...r.tools], sops: [...r.sops], from: [r.id] }));
  const names = new Map(groups.map((g, i) => [g, [roles[i]!.name]]));
  while (groups.length > target) {
    let best: [number, number] = [0, 1], bestScore = -1, bestSize = Infinity;
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const score = overlap(groups[i]!, groups[j]!), size = groups[i]!.from.length + groups[j]!.from.length;
      if (score > bestScore || (score === bestScore && size < bestSize)) { best = [i, j]; bestScore = score; bestSize = size; }
    }
    const [a, b] = [groups[best[0]]!, groups[best[1]]!];
    const merged: PlanRole = {
      name: '', duty: `${a.duty}\n${b.duty}`.slice(0, 4000),
      tools: [...new Set([...a.tools, ...b.tools])], sops: [...new Set([...a.sops, ...b.sops])], from: [...a.from, ...b.from],
    };
    const allNames = [...names.get(a)!, ...names.get(b)!];
    names.set(merged, allNames);
    merged.name = (allNames.length <= 3 ? allNames.join(labels.join) : labels.more(allNames[0]!, allNames.length)).slice(0, 160);
    groups = groups.filter((_, k) => k !== best[0] && k !== best[1]);
    groups.splice(best[0], 0, merged);
  }
  return groups;
}
