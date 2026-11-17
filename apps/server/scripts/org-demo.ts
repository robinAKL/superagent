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

const { createRuntime } = await import('../src/bootstrap.js');
const runtime = await createRuntime({ ...process.env, AUTH_MODE: 'dev', APP_ROLE: 'web' });
const knowledge = createKnowledgeDeps(runtime);

const pick = (evidence: Evidence[], ...needles: string[]) => {
  const hit = evidence.find(e => needles.some(n => e.quote.includes(n))) ?? evidence[0];
  if (!hit) throw new Error('no evidence');
  return [hit];
};
const scripted: AnalysisModel = {
  async check() { /* scripted model is always ready */ },
  async recommend({ evidence }) {
    return [
      { key: 'order-reviewer', kind: 'employee', name: '订单审核员', description: '收到订单后核对客户信用额度和订单金额，超额订单提交主管审批，审核结论登记到订单系统。', evidence: pick(evidence, '信用额度'), uses: ['policy-qa', 'order-entry'], sops: ['order-review'] },
      { key: 'credit-analyst', kind: 'employee', name: '信用分析员', description: '维护客户信用额度，评估超额申请的风险。', evidence: pick(evidence, '信用'), uses: ['policy-qa'], sops: ['order-review'] },
      { key: 'policy-qa', kind: 'tool', name: '知识库问答', description: '查询价格政策和审核规则。', evidence: pick(evidence, '价格政策') },
      { key: 'order-entry', kind: 'tool', name: '订单系统登记', description: '把审核结论和审批记录写入订单系统。', evidence: pick(evidence, '登记') },
      { key: 'order-review', kind: 'sop', name: '订单审核流程', description: '收到订单 → 核对信用额度 → 金额超过 5 万提交主管审批 → 登记审核结论。', evidence: pick(evidence, '审批') },
    ];
  },
};
knowledge.model = scripted;
knowledge.enqueue = async (ctx, runId) => { setTimeout(() => void runAnalysis(knowledge.repo, scripted, ctx, runId), 1500); };

const longwork = createLongWorkDeps(runtime);
const app = await buildApp({ ...runtime.app, knowledgeDeps: knowledge, longWorkDeps: longwork, serveWeb: true, logger: false });
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 8080) });
console.log('org demo listening');
