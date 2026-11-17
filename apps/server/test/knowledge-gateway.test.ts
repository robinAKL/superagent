import { it, expect } from 'vitest';
import type { ChatResponse } from '@superagent/shared';
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
 expect(await model.recommend({tenantId:'t',runId:'r',evidence:[file,live],maxOutputTokens:4096})).toEqual([{...draft,evidence:[file,live]}]);
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
 await expect(model.recommend({tenantId:'t',runId:'r',evidence:[file],maxOutputTokens:8192})).resolves.toEqual([{evidence:[file]}]);
 expect(requests).toEqual([
  {maxOutputTokens:4096,limit:'at most 8 distinct drafts',taskId:'r'},
  {maxOutputTokens:8192,limit:'at most 3 distinct drafts',taskId:'r'},
 ]);
});
