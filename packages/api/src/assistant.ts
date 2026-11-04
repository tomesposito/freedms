import { AssistantBilling, ANSWER_PRICE, priceForTool, zeroUsage, type AssistantMeter } from './assistant-billing.js';
import type { AuthClaims, Principal } from '@freedms/shared';
import type { AssistantMessage, AssistantProvider, AssistantToolSpec } from './assistant-provider.js';
import { assistantUnavailable, assistantFailure } from './assistant-provider.js';
import { ApiError } from './errors.js';
import { parseBody, response, type ApiRequest, type ApiResponse } from './handler.js';
import { invalid, object, onlyKeys } from './validation.js';
import { tools } from './mcp/tools.js';
import { executeTool } from './mcp/execute.js';
export interface AssistantEntitlement { check(principal: Principal): Promise<boolean> }
export class DenyAssistantEntitlement implements AssistantEntitlement {
  async check(_principal: Principal) { return false; }
}
export const assistantToolSpecs: AssistantToolSpec[] = tools.map(({name, description, inputSchema}) => ({toolSpec: {
  name, description, inputSchema: {json: inputSchema as NonNullable<NonNullable<NonNullable<AssistantToolSpec['toolSpec']>['inputSchema']>['json']>},
}}));
const stepLimit = 'The assistant hit the step limit for this message. Please send another message to continue.';
export async function runAssistant(messages: AssistantMessage[], provider: AssistantProvider, claims: AuthClaims,
  execute: (request: ApiRequest) => Promise<ApiResponse>, meter?: AssistantMeter) {
  const history = structuredClone(messages), transcript: {tool: string; ok: boolean}[] = [];
  const finish = async (reply: string) => ({reply, transcript, creditsUsed: await meter?.finish() ?? 0});
  for (let round = 0; round <= 10; round++) {
    const answer = await provider.converse(history, assistantToolSpecs);
    const calls = answer.content?.flatMap(block => block.toolUse ? [block.toolUse] : []) ?? [];
    let usage = provider.lastUsage ? {...provider.lastUsage} : zeroUsage;
    if (!calls.length) {
      // Every no-tool final round costs one credit, including after tool rounds.
      // Never expose an answer that cannot be paid for: return the stop note instead.
      const stop = meter?.stop(ANSWER_PRICE);
      if (stop) return finish(stop);
      meter?.charge('answer', ANSWER_PRICE, usage);
      return finish(answer.content?.map(block => block.text ?? '').join('\n') ?? '');
    }
    if (round === 10) return finish(stepLimit);
    if (calls.length > 20 || calls.some(call => !call.toolUseId || !call.name) || new Set(calls.map(call => call.toolUseId)).size !== calls.length) throw assistantFailure();
    history.push(answer);
    const results: NonNullable<AssistantMessage['content']> = [];
    for (const call of calls) {
      const tool = tools.find(tool => tool.name === call.name);
      const price = priceForTool(call.name!);
      const stop = price && meter?.stop(price);
      if (stop) return finish(stop);
      const result = tool ? await executeTool(tool, call.input, claims, execute)
        : {isError: true, content: [{text: 'Tool unavailable.'}]};
      if (!result.isError && price) { meter?.charge(call.name!, price, usage); usage = zeroUsage; }
      transcript.push({tool: call.name!, ok: !result.isError});
      const raw = result.content.map(block => block.text).join('\n');
      const text = raw.length > 16000 ? raw.slice(0, 16000) + '\n[Tool result truncated]' : raw;
      results.push({toolResult: {toolUseId: call.toolUseId!, status: result.isError ? 'error' : 'success', content: [{text}]}});
    }
    history.push({role: 'user', content: results});
  }
  return finish(stepLimit);
}
export async function assistantChat(request: ApiRequest, principal: Principal, provider: AssistantProvider,
  entitlement: AssistantEntitlement, execute: (request: ApiRequest) => Promise<ApiResponse>) {
  // Fail closed before any provider or tool call, including when no model is configured.
  if (entitlement instanceof AssistantBilling) await entitlement.requireEntitlement(principal);
  else if (!await entitlement.check(principal)) throw new ApiError(402, 'ASSISTANT_PLAN_REQUIRED', 'An AI assistant plan is required.');
  if (!provider.configured) throw assistantUnavailable();
  const input = parseBody(request.body); onlyKeys(input, ['messages']);
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 50) throw invalid('Provide 1–50 conversation turns.');
  const messages: AssistantMessage[] = input.messages.map((raw, index) => {
    const turn = object(raw); onlyKeys(turn, ['role', 'text']);
    if (turn.role !== (index % 2 === 0 ? 'user' : 'assistant') || typeof turn.text !== 'string' || !turn.text.trim() || turn.text.length > 16000) throw invalid('Provide alternating user/assistant turns with nonempty text of at most 16000 characters.');
    return {role: turn.role as 'user' | 'assistant', content: [{text: turn.text}]};
  });
  if (messages.at(-1)?.role !== 'user') throw invalid('The last turn must be from the user.');
  return response(200, {data: await runAssistant(messages, provider, request.claims!, execute, entitlement instanceof AssistantBilling ? await entitlement.meter(principal) : undefined)});
}
