/**
 * LOCAL DEMO HARNESS — not shipped. Starts the real web app in AUTH_MODE=dev, but swaps the analysis model for a
 * scripted one so the knowledge → organization flow can be walked in a browser without a model provider key.
 * Everything else (upload, confirmation, analysis pipeline, organization confirm, employee/tool registries) is real.
 *   npx tsx --env-file-if-exists=../../.env scripts/org-demo.ts
 */
import { buildApp } from '../src/app.js';
import { createKnowledgeDeps } from '../src/modules/knowledge/runtime.js';
import { createLongWorkDeps } from '../src/modules/longwork/runtime.js';
import { runAnalysis, type AnalysisModel } from '../src/modules/analysis/service.js';
import type { Evidence } from '../src/modules/knowledge/domain.js';
import { mergeByOverlap } from '../src/modules/knowledge/team-plan.js';

const { createRuntime } = await import('../src/bootstrap.js');
const runtime = await createRuntime({ ...process.env, AUTH_MODE: 'dev', APP_ROLE: 'web' });
const knowledge = createKnowledgeDeps(runtime);

const pick = (evidence: Evidence[], ...needles: string[]) => {
  const supports = (excerpt: Evidence) => needles.some(term => excerpt.quote.includes(term));
  const hit = evidence.find(excerpt => !excerpt.quote.trimStart().startsWith('#') && supports(excerpt))
    ?? evidence.find(supports) ?? evidence[0];
  if (!hit) throw new Error('no evidence');
  return [hit];
};
const scripted: AnalysisModel = {
  async check() { /* scripted model is always ready */ },
  async recommend({ evidence }) {
    const flowSources = ['收到订单', '信用额度', '审批', '登记'].map(term => pick(evidence, term)[0]!);
    const flowEvidence = [...new Set(flowSources)];
    const cite = (index: number) => [flowEvidence.indexOf(flowSources[index]!) + 1];
    return [
      { key: 'order-reviewer', kind: 'employee', name: '订单审核员', description: '收到订单后核对客户信用额度和订单金额，超额订单提交主管审批，审核结论登记到订单系统。', evidence: pick(evidence, '信用额度'), uses: ['policy-qa', 'order-entry'], sops: ['order-review'] },
      { key: 'credit-analyst', kind: 'employee', name: '信用分析员', description: '维护客户信用额度，评估超额申请的风险。', evidence: pick(evidence, '信用'), uses: ['policy-qa'], sops: ['order-review'] },
      { key: 'policy-qa', kind: 'tool', name: '知识库问答', description: '查询价格政策和审核规则。', evidence: pick(evidence, '价格政策') },
      { key: 'order-entry', kind: 'tool', name: '订单系统登记', description: '把审核结论和审批记录写入订单系统。', evidence: pick(evidence, '登记') },
      { key: 'order', kind: 'object', name: '订单', description: '客户提交的采购订单，含金额、折扣和交期。', evidence: pick(evidence, '订单') },
      { key: 'customer', kind: 'object', name: '客户', description: '下单客户及其信用额度。', evidence: pick(evidence, '客户') },
      { key: 'credit-limit', kind: 'object', name: '信用额度', description: '客户可赊销的上限。', evidence: pick(evidence, '信用额度') },
      { key: 'price-policy', kind: 'object', name: '价格政策', description: '折扣与价格规则。', evidence: pick(evidence, '价格政策') },
      { key: 'approval', kind: 'object', name: '主管审批', description: '金额超过 5 万元时的审批记录。', evidence: pick(evidence, '审批') },
      { key: 'order-system', kind: 'object', name: '订单系统记录', description: '审核结论和审批记录的登记。', evidence: pick(evidence, '登记') },
      { key: 'rel-1', kind: 'relation', name: '客户提交订单', description: '客户提交订单。', relation: { from: 'customer', to: 'order', label: '提交' }, evidence: pick(evidence, '订单') },
      { key: 'rel-2', kind: 'relation', name: '客户拥有信用额度', description: '客户拥有信用额度。', relation: { from: 'customer', to: 'credit-limit', label: '拥有' }, evidence: pick(evidence, '信用额度') },
      { key: 'rel-3', kind: 'relation', name: '订单受信用额度约束', description: '订单受信用额度约束。', relation: { from: 'order', to: 'credit-limit', label: '核对' }, evidence: pick(evidence, '信用额度') },
      { key: 'rel-4', kind: 'relation', name: '订单适用价格政策', description: '订单适用价格政策。', relation: { from: 'order', to: 'price-policy', label: '适用' }, evidence: pick(evidence, '价格政策') },
      { key: 'rel-5', kind: 'relation', name: '超额订单需要审批', description: '超额订单需要审批。', relation: { from: 'order', to: 'approval', label: '超 5 万需' }, evidence: pick(evidence, '审批') },
      { key: 'rel-6', kind: 'relation', name: '审批写入订单系统', description: '审批写入订单系统。', relation: { from: 'approval', to: 'order-system', label: '登记到' }, evidence: pick(evidence, '登记') },
      { key: 'rel-7', kind: 'relation', name: '订单登记到订单系统', description: '订单登记到订单系统。', relation: { from: 'order', to: 'order-system', label: '登记到' }, evidence: pick(evidence, '登记') },
      {
        key: 'order-review', kind: 'sop', name: '订单审核流程',
        description: '核对客户信用额度，处理需要人工复核的订单，并登记审核结论。',
        evidence: flowEvidence,
        workflow: {
          completion: '订单系统留存审核结论及审批记录。',
          steps: [
            { key: 'receive', kind: 'trigger', label: '收到客户订单', after: [], citations: cite(0) },
            { key: 'limit', kind: 'employee', label: '核对金额与信用额度', employeeKey: 'order-reviewer', after: ['receive'], citations: cite(1) },
            { key: 'review', kind: 'human_review', label: '主管复核订单', detail: '核对超过 5 万元的订单是否已取得审批。', after: ['limit'], citations: cite(2) },
            { key: 'register', kind: 'tool', label: '登记审核结论', toolKey: 'order-entry', after: ['review'], citations: cite(3) },
          ],
        },
      },
    ];
  },
};
// Scripted team re-planning: merge by shared work when shrinking; split the broadest role when growing.
scripted.planTeam = async ({ roles, target }) => {
  if (target < roles.length) return mergeByOverlap(roles.map(r => ({ ...r, edited: false })), target, { join: '与', more: (f, n) => `${f}等${n}岗` })
    .map(r => ({ ...r, name: r.from.length > 1 ? `${r.name.split('与')[0]}（综合）` : r.name }));
  const out = roles.map(r => ({ name: r.name, duty: r.duty, tools: [...r.tools], sops: [...r.sops], from: [r.id] }));
  while (out.length < target) {
    const widest = out.reduce((a, b) => (b.tools.length + b.sops.length > a.tools.length + a.sops.length ? b : a));
    const half = Math.ceil(widest.tools.length / 2);
    out.push({ name: `${widest.name.replace(/（.*）$/, '')}（专项 ${out.length - roles.length + 1}）`, duty: `分担「${widest.name}」的部分工作：${widest.duty}`, tools: widest.tools.slice(half), sops: [...widest.sops], from: [...widest.from] });
    widest.tools = widest.tools.slice(0, half) .length ? widest.tools.slice(0, half) : widest.tools;
  }
  return out;
};
knowledge.model = scripted;
knowledge.enqueue = async (ctx, runId) => { setTimeout(() => void runAnalysis(knowledge.repo, scripted, ctx, runId), 1500); };

const longwork = createLongWorkDeps(runtime);
const app = await buildApp({ ...runtime.app, knowledgeDeps: knowledge, longWorkDeps: longwork, serveWeb: true, logger: false });
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 8080) });
console.log('org demo listening');
