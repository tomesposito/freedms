import { escapeHtml as e } from './format';
import type { UI } from './desking';
export function loadErrorHtml(error: unknown, title = 'This page could not be loaded.', retry = true): string {
  return `<section class="card"><h2>${e(title)}</h2><p class="error" role="alert">${e(error instanceof Error ? error.message : 'The request could not be completed.')}</p>${retry ? '<button type="button" id="retry-load">Retry</button>' : ''}</section>`;
}
export function bindLoadRetry(retry: () => void): void {
  document.querySelector('#retry-load')?.addEventListener('click', retry);
}
export function showLoadError(ui: UI, error: unknown, retry: () => void = ui.refresh): void {
  if (!ui.current()) return;
  ui.shell(loadErrorHtml(error));
  bindLoadRetry(retry);
  ui.flash(error);
}
