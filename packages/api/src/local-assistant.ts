/** LOCAL TEST DOUBLE ONLY. Imported solely by local.ts; never by Lambda or provider selection. */
import type { AssistantMessage, AssistantProvider, PhotoPrepImageEditor } from './assistant-provider.js';
export class LocalAssistantProvider implements AssistantProvider {
  configured = true;
  readonly photoPrepImageEditor: PhotoPrepImageEditor = {
    configured: true,
    source: 'stub',
    async replaceBackground(jpeg, signal) {
      signal.throwIfAborted();
      return jpeg;
    },
  };
  async converse(messages: AssistantMessage[]): Promise<AssistantMessage> {
    const last = messages.at(-1)?.content ?? [];
    if (last[0]?.text?.startsWith('Photo prep observations.') && last.some(block => block.image)) {
      return {role: 'assistant', content: [{text: JSON.stringify({label: 'exterior', coverScore: 80, visible: 'Exterior shown'})}]};
    }
    if (last[0]?.text?.startsWith('Photo prep description.')) {
      const {year, make, model, trim} = JSON.parse(last[0].text.split('Data: ').at(-1)!);
      return {role: 'assistant', content: [{text: [year, make, model, trim].filter(Boolean).join(' ')}]};
    }
    const result = last.find(block => block.toolResult)?.toolResult;
    if (result) {
      if (result.status === 'error') return {role: 'assistant', content: [{text: 'Local test double: the inventory lookup failed.'}]};
      const raw = result.content?.[0]?.text ?? '{}';
      let summary = 'Inventory lookup completed.';
      try {
        const data = JSON.parse(raw).data;
        const rows = Array.isArray(data) ? data : data?.items;
        if (Array.isArray(rows)) summary = `Found ${rows.length} vehicle(s). ${rows.slice(0, 3).map(row => `${row.stockNumber}: ${row.year} ${row.make} ${row.model}`).join('; ')}`;
      } catch { summary = 'Inventory results were truncated.'; }
      return {role: 'assistant', content: [{text: `Local test double: ${summary}`}]};
    }
    // Context is a separate leading block; the offline double matches only the user's request.
    const prompt = last.length > 1 && /^(Current context:|No context record is available\.)/.test(last[0].text ?? '') ? last.slice(1) : last;
    const text = prompt.map(block => block.text ?? '').join(' ');
    if (/vehicle|\bvin\b|\bstock\b/i.test(text)) {
      const search = text.match(/\b[A-HJ-NPR-Z0-9]{17}\b/i)?.[0] ?? text.match(/\bstock\s+(?:number\s+)?[#:]?\s*([\w-]+)/i)?.[1];
      return {role: 'assistant', content: [{toolUse: {toolUseId: 'local-lookup', name: 'search_vehicles', input: {limit: 10, ...(search ? {search} : {})}}}]};
    }
    return {role: 'assistant', content: [{text: 'This is the local assistant test double.'}]};
  }
}
