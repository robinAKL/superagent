import { it, expect } from 'vitest';
import type { ChatResponse } from '@superagent/shared';
import { validateProposals } from '../src/modules/analysis/service.js';
import { GatewayAnalysisModel, type AnalysisGateway } from '../src/modules/analysis/gateway-model.js';
it('analysis uses only the budget gateway, bounded output and an untrusted-source system instruction', async () => {
 let request: unknown; const gateway: AnalysisGateway = { check: async () => ({ok:true,model:'m'}), chat: async (_tenant,_tier,req) => { request=req; return {text:'[]',toolCalls:[],usage:{inputTokens:1,outputTokens:1},stopReason:'end'}; } };
 const model = new GatewayAnalysisModel(gateway); await model.check('t'); expect(await model.recommend({tenantId:'t',runId:'r',evidence:[],maxOutputTokens:4096})).toEqual([]);
 expect(request).toMatchObject({maxOutputTokens:4096,taskId:'r'}); expect((request as {messages:{content:string}[]}).messages[0]!.content).toContain('untrusted data');
});
it('model readiness preserves specific setup errors before a job is created', async () => {
 const model = new GatewayAnalysisModel({check:async()=>({ok:false,code:'llm_not_configured'}),chat:async()=>{throw Error('must not call')}});
 await expect(model.check('t')).rejects.toMatchObject({code:'llm_not_configured',statusCode:503});
});
it('invalid model JSON and tool calls cannot become organization drafts', async () => {
 const response: ChatResponse = {text:'```json\n[\n```',toolCalls:[],usage:{inputTokens:1,outputTokens:1},stopReason:'end'};
 const model = new GatewayAnalysisModel({check:async()=>({ok:true,model:'m'}),chat:async()=>response});
 await expect(model.recommend({tenantId:'t',runId:'r',evidence:[],maxOutputTokens:4096})).rejects.toMatchObject({code:'invalid_model_output'});
 response.text='[]'; response.toolCalls=[{id:'t',name:'publish',input:{}}]; await expect(model.recommend({tenantId:'t',runId:'r',evidence:[],maxOutputTokens:4096})).rejects.toMatchObject({code:'invalid_model_output'});
});

it('resolves fenced drafts for uploaded files and MCP to the exact supplied citations', async () => {
 const file = {sourceId:'file',version:'v1',start:12,end:16,locator:'handbook.md:2',quote:'复核金额'};
 const live = {sourceId:'mcp:run:1:0',version:'v2',start:0,end:4,locator:'Inventory / policy://receipts',quote:'核对收据',retrievedAt:'2026-11-16T00:00:00Z'};
 const draft = {key:'verify',kind:'sop',name:'付款前核对',description:'复核金额及收据。',evidence:[1,2]};
 const model = new GatewayAnalysisModel({
  check:async()=>({ok:true,model:'m'}),
  chat:async(_tenant,_tier,req)=>{
   expect(JSON.parse(req.messages[1]!.content).evidence).toEqual([
    {citation:1,locator:file.locator,quote:file.quote},
    {citation:2,locator:live.locator,quote:live.quote},
   ]);
   return {text:'```json\n'+JSON.stringify([draft])+'\n```',toolCalls:[],usage:{inputTokens:1,outputTokens:1},stopReason:'stop'};
  },
 });
 expect(await model.recommend({tenantId:'t',runId:'r',evidence:[file,live],maxOutputTokens:4096})).toEqual([{...draft,kind:'object',ruleLike:true,evidence:[file,live]}]);
});

it('retains real workflow nodes only with connected dependencies and supplied step citations', async () => {
  const excerpts = [
    { sourceId: 'policy', version: 'v2', start: 0, end: 4, locator: 'Guide#L1', quote: '收到订单' },
    { sourceId: 'policy', version: 'v2', start: 5, end: 13, locator: 'Guide#L2', quote: '核对客户信用额度' },
    { sourceId: 'policy', version: 'v2', start: 14, end: 18, locator: 'Guide#L3', quote: '登记结论' },
  ];
  const steps = [
    { key: 'receive', kind: 'trigger', label: '收到订单', after: [], citations: [1] },
    { key: 'review', kind: 'employee', label: '核对客户信用额度', after: ['receive'], citations: [2], employeeKey: 'credit-reviewer' },
    { key: 'record', kind: 'tool', label: '登记结论', after: ['review'], citations: [3] },
  ];
  const proposal = {
    key: 'order-review', kind: 'sop', name: '订单审核', description: '收到订单后核对客户信用额度。',
    evidence: [2, 1, 3], workflow: { steps },
  };
  const model = new GatewayAnalysisModel({
    check: async () => ({ ok: true, model: 'test' }),
    chat: async () => ({ text: JSON.stringify([proposal]), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' }),
  });
  const input = { tenantId: 't', runId: 'r', evidence: excerpts, maxOutputTokens: 4096 };
  let [draft] = validateProposals(await model.recommend(input));
  expect(draft?.workflow?.steps).toMatchObject([
    { key: 'receive', citations: [2], after: [] },
    { key: 'review', citations: [1], after: ['receive'], employeeKey: 'credit-reviewer' },
    { key: 'record', citations: [3], after: ['review'] },
  ]);
  expect(draft?.evidence[0]?.locator).toBe('Guide#L2');
  steps[1]!.after = ['unknown'];
  [draft] = validateProposals(await model.recommend(input));
  expect(draft?.workflow).toBeUndefined();
  steps[1]!.after = ['receive'];
  steps[1]!.citations = [4]; // present in the input, absent from the proposal's verified citations
  [draft] = validateProposals(await model.recommend(input));
  expect(draft?.workflow).toBeUndefined();
});

it('distinguishes a citation outside the uploaded file excerpts from a truncated response', async () => {
 const file = {sourceId:'file',version:'v1',start:0,end:4,locator:'handbook.md:1',quote:'复核金额'};
 const response: ChatResponse = {text:'[{"evidence":[2]}]',toolCalls:[],usage:{inputTokens:1,outputTokens:1},stopReason:'stop'};
 const model = new GatewayAnalysisModel({
  check:async()=>({ok:true,model:'m'}),
  chat:async(_tenant,_tier,req)=>{
   expect(JSON.parse(req.messages[1]!.content).evidence).toEqual([{citation:1,locator:file.locator,quote:file.quote}]);
   return response;
  },
 });
 const input = {tenantId:'t',runId:'r',evidence:[file],maxOutputTokens:4096};
 await expect(model.recommend(input)).rejects.toMatchObject({code:'unsupported_recommendation'});
 response.stopReason='length'; response.text='[{"evidence":[1]';
 await expect(model.recommend(input)).rejects.toMatchObject({code:'analysis_output_truncated'});
 response.stopReason='stop'; response.text='[{"evidence":[1]}]';
 await expect(model.recommend(input)).resolves.toEqual([{evidence:[file]}]);
});

it('retries a confirmed output limit once through the budget gateway with fewer drafts', async () => {
 const file = {sourceId:'file',version:'v1',start:0,end:4,locator:'handbook.md:1',quote:'复核金额'};
 const requests: { maxOutputTokens: number; limit: string | undefined; taskId?: string }[] = [];
 const model = new GatewayAnalysisModel({
  check:async()=>({ok:true,model:'m'}),
  chat:async(_tenant,_tier,req)=>{
   requests.push({maxOutputTokens:req.maxOutputTokens,limit:req.messages[0]!.content.match(/at most \d+ distinct drafts/)?.[0],taskId:req.taskId});
   const stopped = requests.length === 1;
   return {text:stopped ? '[' : '[{"evidence":[1]}]',toolCalls:[],usage:{inputTokens:1,outputTokens:1},stopReason:stopped ? 'length' : 'stop'};
  },
 });
 await expect(model.recommend({tenantId:'t',runId:'r',evidence:[file],maxOutputTokens:16384})).resolves.toEqual([{evidence:[file]}]);
 expect(requests).toEqual([
  {maxOutputTokens:8192,limit:'at most 15 distinct drafts',taskId:'r'},
  {maxOutputTokens:16384,limit:'at most 8 distinct drafts',taskId:'r'},
 ]);
});

it('a cadence the sources state becomes the workflow’s schedule, cited; an uncited or malformed one is dropped and the workflow kept', async () => {
  const excerpts = [
    { sourceId: 'manual', version: 'v1', start: 0, end: 10, locator: 'Ops#L1', quote: '每周一上午 9 点汇总上周订单' },
    { sourceId: 'manual', version: 'v1', start: 11, end: 20, locator: 'Ops#L2', quote: '销售经理审阅周报' },
  ];
  const workflow: Record<string, unknown> = {
    steps: [
      { key: 'monday', kind: 'trigger', label: '每周一 9 点', after: [], citations: [1] },
      { key: 'report', kind: 'employee', label: '汇总上周订单写周报', after: ['monday'], citations: [2] },
      { key: 'review', kind: 'human_review', label: '销售经理审阅', after: ['report'], citations: [2] },
    ],
    schedule: { freq: 'weekly', weekdays: [1], time: '09:00', citation: 1 },
  };
  const proposal = { key: 'weekly-report', kind: 'sop', name: '周报', description: '每周一汇总上周订单。', evidence: [2, 1], workflow };
  const model = new GatewayAnalysisModel({
    check: async () => ({ ok: true, model: 'test' }),
    chat: async (_t, _tier, req) => {
      expect(req.messages[0]!.content).toContain('workflow.schedule');
      return { text: JSON.stringify([proposal]), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' };
    },
  });
  const input = { tenantId: 't', runId: 'r', evidence: excerpts, maxOutputTokens: 4096 };
  let [draft] = validateProposals(await model.recommend(input));
  // Excerpt 1 is the draft's second piece of evidence.
  expect(draft?.workflow?.schedule).toEqual({ freq: 'weekly', weekdays: [1], hour: 9, minute: 0, timezone: 'Pacific/Auckland', citation: 2 });
  workflow.schedule = { freq: 'weekly', weekdays: [1], time: '09:00' };
  [draft] = validateProposals(await model.recommend(input));
  expect(draft?.workflow?.schedule).toBeUndefined();
  expect(draft?.workflow?.steps).toHaveLength(3);
  workflow.schedule = { freq: 'hourly', citation: 1 };
  [draft] = validateProposals(await model.recommend(input));
  expect(draft?.workflow?.schedule).toBeUndefined();
});
