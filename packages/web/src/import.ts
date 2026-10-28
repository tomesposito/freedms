import { inventoryCsvRows, inventoryCsvHeaders } from '@freedms/shared';
import type { ImportPreview, ImportResult, ImportRowResult, InventoryImport } from '@freedms/shared';
import { escapeHtml as e } from './format';
import type { UI } from './desking';
const reasons = (row: {errors?: ImportRowResult['errors']; duplicate?: ImportRowResult['duplicate']}) => [...(row.errors ?? []).map(err => `${err.field}: ${err.message}`), ...(row.duplicate ? [row.duplicate.reason] : [])].join(' ');
export async function importRoute(ui: UI): Promise<void> {
  ui.shell(`<a class="back" href="#/">← Inventory</a><h1>Import inventory</h1><p>Preview first. Nothing is written until you confirm. CSV cost and price are in dollars. Common header aliases are accepted. Stock number is optional: missing or blank values become IMP- plus the last 8 characters of the uppercase VIN, with -2, -3, … added if needed for uniqueness.</p><form id="import-form" class="card"><label>Vehicle CSV<input id="import-file" type="file" accept=".csv,text/csv"></label><label><input id="import-enrich" type="checkbox"> Fill missing year/make/model from VIN decode</label><button id="import-preview">Preview import</button></form><p id="import-error" role="alert"></p><section id="import-results" aria-live="polite"></section><section class="card"><h2>Import history</h2><div id="import-history">Loading imports…</div></section>`);
  const file = document.querySelector<HTMLInputElement>('#import-file')!;
  const enrich = document.querySelector<HTMLInputElement>('#import-enrich')!;
  const previewButton = document.querySelector<HTMLButtonElement>('#import-preview')!;
  const output = document.querySelector<HTMLElement>('#import-results')!;
  const errorOutput = document.querySelector<HTMLElement>('#import-error')!;
  let revision = 0;
  const invalidate = () => { revision++; output.innerHTML = ''; errorOutput.textContent = ''; };
  file.addEventListener('change', invalidate); enrich.addEventListener('change', invalidate);
  const history = async () => {
    const records = await ui.api<InventoryImport[]>('/vehicles/imports'); if (!ui.current()) return;
    document.querySelector('#import-history')!.innerHTML = records.length ? `<ul>${records.map(r => `<li>${e(r.createdAt)} · ${e(r.importedCount)} imported · ${e(r.duplicateCount)} duplicates skipped · ${e(r.errorCount)} with errors</li>`).join('')}</ul>` : '<p>No imports yet.</p>';
  };
  document.querySelector<HTMLFormElement>('#import-form')!.addEventListener('submit', async event => {
    event.preventDefault(); invalidate(); const currentRevision = revision;
    if (!file.files?.[0]) { errorOutput.textContent = 'Choose a CSV file first.'; return; }
    previewButton.disabled = true;
    try {
      const body = {csv: await file.files[0].text(), enrich: enrich.checked};
      const p = await ui.api<ImportPreview>('/vehicles/import/preview', 'POST', body);
      if (!ui.current() || revision !== currentRevision) return;
      const [header, ...csvData] = inventoryCsvRows(body.csv);
      const rawSummary = (rowNumber: number) => {
        const fields: Record<string, string> = {};
        header.forEach((h, i) => { const key = h.trim().toLowerCase(); if (Object.hasOwn(inventoryCsvHeaders, key)) fields[inventoryCsvHeaders[key]] = csvData[rowNumber - 1][i].trim(); });
        return `${fields.year ?? ''} ${fields.make ?? ''} ${fields.model ?? ''} · ${fields.stockNumber ?? ''} · ${fields.vin ?? ''}`;
      };
      output.innerHTML = `<h2>Preview</h2><p>${e(p.validCount)} valid · ${e(p.errorCount)} with errors · ${e(p.duplicateCount)} duplicates out of ${e(p.totalRows)} rows</p><div class="table-wrap"><table><thead><tr><th>Row</th><th>Vehicle</th><th>Status</th><th>Details</th></tr></thead><tbody>${p.rows.map(r => `<tr><td>${e(r.rowNumber)}</td><td>${r.vehicle ? e(`${r.vehicle.year} ${r.vehicle.make} ${r.vehicle.model} · ${r.vehicle.stockNumber} · ${r.vehicle.vin}`) : e(rawSummary(r.rowNumber))}</td><td><span class="badge">${e({valid: 'Valid', error: 'Error', duplicate: 'Duplicate'}[r.status])}</span></td><td>${e(reasons(r))}</td></tr>`).join('')}</tbody></table></div><button id="import-confirm" class="primary" ${p.validCount ? '' : 'disabled'}>Import ${e(p.validCount)} vehicles</button>`;
      document.querySelector<HTMLButtonElement>('#import-confirm')!.addEventListener('click', async event => {
        const button = event.currentTarget as HTMLButtonElement; button.disabled = true;
        file.disabled = enrich.disabled = previewButton.disabled = true;
        try {
          const result = await ui.api<ImportResult>('/vehicles/import', 'POST', body);
          if (!ui.current()) return;
          output.innerHTML = `<h2>Import result</h2><p>${e(result.importedCount)} imported · ${e(result.duplicateCount)} duplicates skipped · ${e(result.errorCount)} rows with errors</p>${result.skipped.length ? `<ul>${result.skipped.map(r => `<li>Row ${e(r.rowNumber)}: ${e(reasons(r))}</li>`).join('')}</ul>` : ''}<a class="button" href="#/">Back to Inventory</a>`;
          await history();
        } catch (error) { if (ui.current()) errorOutput.textContent = error instanceof Error ? error.message : 'Import failed. Preview again to check the current inventory.'; }
        finally { file.disabled = enrich.disabled = previewButton.disabled = false; }
      });
    } catch (error) { if (ui.current() && revision === currentRevision) errorOutput.textContent = error instanceof Error ? error.message : 'Could not preview CSV.'; }
    finally { previewButton.disabled = false; }
  });
  try { await history(); } catch (error) { if (ui.current()) ui.flash(error); }
}
