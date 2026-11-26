import { hearAboutOptions } from '@freedms/shared';
import { invalid, text } from './validation.js';

/**
 * Optional signup attribution (#208). Never a gate: an absent answer stores
 * empty strings. The prompt is kept only for the AI-assistant answer — it is
 * the exact wording the dealer asked an assistant, so any other source stores
 * no prompt even if a client sends one.
 */
export function hearAbout(input: Record<string, unknown>): {hearAbout: string; hearAboutPrompt: string} {
  const value = text(input.hearAbout ?? '', 'How did you hear about freeDMS', 40, true);
  if (value && !hearAboutOptions.some(option => option.value === value)) throw invalid('Invalid answer for how you heard about freeDMS.');
  const prompt = value === 'ai-assistant' ? text(input.hearAboutPrompt ?? '', 'What you asked the assistant', 500, true) : '';
  return {hearAbout: value, hearAboutPrompt: prompt};
}
