import { hearAboutOptions } from '@freedms/shared';
import { escapeHtml as e } from './format';

/**
 * Optional signup attribution fields (#208). One shared rendering for the
 * onboarding wizard's final step and the invite-acceptance form: the prompt
 * field exists in the DOM only as a hidden extra until the AI option is
 * picked, and neither field is ever required.
 */
export function hearAboutFieldsHtml(value = '', prompt = ''): string {
  return `<label>How did you hear about freeDMS? (optional)<select name="hearAbout"><option value="">Select…</option>${hearAboutOptions.map(option => `<option value="${option.value}" ${value === option.value ? 'selected' : ''}>${e(option.label)}</option>`).join('')}</select></label><label data-hear-about-prompt ${value === 'ai-assistant' ? '' : 'hidden'}>What did you ask it? (optional)<input name="hearAboutPrompt" value="${e(prompt)}" maxlength="500" placeholder="e.g. best free DMS for a small used car lot"><small>The exact words help us show up when other dealers ask the same thing.</small></label>`;
}

export function bindHearAbout(form: HTMLFormElement): void {
  const select = form.querySelector<HTMLSelectElement>('[name=hearAbout]');
  const prompt = form.querySelector<HTMLElement>('[data-hear-about-prompt]');
  select?.addEventListener('change', () => { if (prompt) prompt.hidden = select.value !== 'ai-assistant'; });
}

export function readHearAbout(form: HTMLFormElement): {hearAbout: string; hearAboutPrompt: string} {
  const values = new FormData(form);
  const hearAbout = String(values.get('hearAbout') ?? '');
  return {hearAbout, hearAboutPrompt: hearAbout === 'ai-assistant' ? String(values.get('hearAboutPrompt') ?? '') : ''};
}
