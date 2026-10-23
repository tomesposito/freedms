import { reportDatasets, type CustomReport, type ReportDataset, type ReportDefinition, type SavedReport } from '@freedms/shared';
import type { UI } from './desking';
import { escapeHtml as e } from './format';
export function definitionQuery(d: ReportDefinition): string {
  const q = new URLSearchParams({dataset: d.dataset, columns: d.columns.join(',')});
  for (const key of ['from', 'to', 'groupBy'] as const) if (d[key]) q.set(key, d[key]);
  return q.toString();
}
export function customTable(data: CustomReport): string {
  return `<div class="table-wrap"><table><thead><tr>${data.columns.map(c => `<th>${e(c.label)}</th>`).join('')}</tr></thead><tbody>${data.rows.map(row => `<tr>${row.map(cell => `<td>${e(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${data.rows.length ? '' : '<p class="empty">No records match this report.</p>'}`;
}
export const customReportsHtml = `<section class="card"><h2>Custom reports</h2><p>Money is shown in USD with two decimals, exactly as exported. Grouping sums numeric columns, leaves other text blank, and count counts source rows. Inventory dates filter date stocked; leads filter date created; sales and F&I filter sold date (inclusive, UTC).</p><form id="custom-builder"><label>Dataset<select name="dataset">${Object.keys(reportDatasets).map(d => `<option>${d}</option>`).join('')}</select></label><fieldset id="custom-columns"><legend>Columns</legend></fieldset><label>Group by<select name="groupBy"></select></label><div class="filters"><label>From<input type="date" name="from"></label><label>To<input type="date" name="to"></label></div><button>Run</button></form><div id="custom-results"><p>Choose columns and run a report.</p></div><button type="button" id="custom-export" disabled>Export CSV</button><form id="custom-save"><label>Report name<input name="name" required maxlength="120"></label><button disabled>Save current definition</button><p role="status" id="custom-saved-status"></p></form><h3>Saved reports</h3><div id="saved-reports"></div></section>`;
export function bindCustomReports(ui: UI & {download: (path: string, filename: string) => Promise<void>}, initial: SavedReport[]) {
  const form = document.querySelector<HTMLFormElement>('#custom-builder')!, save = document.querySelector<HTMLFormElement>('#custom-save')!;
  const dataset = form.elements.namedItem('dataset') as HTMLSelectElement, grouping = form.elements.namedItem('groupBy') as HTMLSelectElement;
  const exportButton = document.querySelector<HTMLButtonElement>('#custom-export')!, saveButton = save.querySelector('button')!;
  let current: ReportDefinition | undefined, generation = 0;
  const choices = (definition?: ReportDefinition) => {
    const spec = reportDatasets[dataset.value as ReportDataset];
    document.querySelector('#custom-columns')!.innerHTML = `<legend>Columns</legend>${[...spec.columns, {key: 'count', label: 'count'}].map(c => `<label class="check"><input type="checkbox" name="columns" value="${e(c.key)}" ${!definition || definition.columns.includes(c.key) ? 'checked' : ''}>${e(c.label)}</label>`).join('')}`;
    grouping.innerHTML = '<option value="">None</option>' + spec.groupings.map(g => `<option>${e(g)}</option>`).join(''); grouping.value = definition?.groupBy ?? '';
  };
  const invalidate = () => { generation++; current = undefined; exportButton.disabled = saveButton.disabled = true; document.querySelector('#custom-results')!.innerHTML = '<p>Run to see results for these choices.</p>'; };
  choices(); dataset.addEventListener('change', () => choices()); form.addEventListener('change', invalidate);
  const run = async (d: ReportDefinition) => {
    invalidate(); const request = generation;
    try {
      const data = await ui.api<CustomReport>(`/reports/custom?${definitionQuery(d)}`);
      if (!ui.current() || request !== generation) return;
      current = d; document.querySelector('#custom-results')!.innerHTML = customTable(data); exportButton.disabled = saveButton.disabled = false;
    } catch (error) { if (ui.current() && request === generation) ui.flash(error); }
  };
  form.addEventListener('submit', event => {
    event.preventDefault(); const data = new FormData(form);
    const d: ReportDefinition = {dataset: dataset.value as ReportDataset, columns: data.getAll('columns').map(String)};
    for (const key of ['from', 'to', 'groupBy'] as const) if (data.get(key)) d[key] = String(data.get(key));
    void run(d);
  });
  exportButton.addEventListener('click', async () => { if (!current) return; try { await ui.download(`/reports/custom.csv?${definitionQuery(current)}`, 'custom.csv'); } catch (error) { if (ui.current()) ui.flash(error); } });
  const savedList = (items: SavedReport[]) => {
    const container = document.querySelector('#saved-reports')!;
    container.innerHTML = items.length ? items.map(item => `<p>${e(item.name)} <button type="button" data-saved-report="${e(item.id)}">Run</button></p>`).join('') : '<p class="empty">No saved reports yet.</p>';
    container.querySelectorAll<HTMLButtonElement>('[data-saved-report]').forEach(button => button.addEventListener('click', () => {
      const d = items.find(item => item.id === button.dataset.savedReport)!.definition;
      dataset.value = d.dataset; choices(d);
      for (const key of ['from', 'to'] as const) (form.elements.namedItem(key) as HTMLInputElement).value = d[key] ?? '';
      void run(d);
    }));
  };
  savedList(initial);
  save.addEventListener('submit', async event => {
    event.preventDefault(); if (!current) return; saveButton.disabled = true;
    try {
      await ui.api('/reports/saved', 'POST', {...current, name: String(new FormData(save).get('name'))});
      const items = await ui.api<SavedReport[]>('/reports/saved'); if (!ui.current()) return;
      savedList(items); document.querySelector('#custom-saved-status')!.textContent = 'Report definition saved.';
    } catch (error) { if (ui.current()) ui.flash(error); }
    finally { if (ui.current()) saveButton.disabled = !current; }
  });
}
