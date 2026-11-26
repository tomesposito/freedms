import {
  migrationBatchLimit, migrationEntities, migrationLabels, type MigrationEntity,
  type MigrationHistory, type MigrationImport, type MigrationPreview, type MigrationRow, type MigrationTotals
} from '@freedms/shared';
import type { UI } from './desking';
import { escapeHtml as e } from './format';

const labels: Record<string, string> = {
  sourceId: 'Old system record ID', customerSourceId: 'Old system customer ID', leadSourceId: 'Old system lead ID',
  customerEmail: 'Customer email', customerPhone: 'Customer phone', vin: 'VIN', stockNumber: 'Stock number',
  dateStocked: 'Date stocked', listPrice: 'List price', amount: 'Deal amount (pencil price)', firstName: 'First name', lastName: 'Last name',
  vehicleDescription: 'Vehicle description', sourceDetail: 'Source detail'
};
const label = (field: string) => labels[field] ?? field.charAt(0).toUpperCase() + field.slice(1);
const dollars = (cents: number) => new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(cents / 100);
const recordCount = (count: number) => `${count} ${count === 1 ? 'record' : 'records'}`;
const amountLabel = (entity: MigrationEntity) => entity === 'inventory' ? 'Total vehicle cost' : 'Total open deal amount';
function reconciliation(entity: MigrationEntity, expected: MigrationTotals, actual: MigrationTotals) {
  const metrics = [['Record count', String(expected.count), String(actual.count)]];
  if (expected.amountCents !== undefined && actual.amountCents !== undefined) {
    metrics.push([amountLabel(entity), dollars(expected.amountCents), dollars(actual.amountCents)]);
  }
  return `<div class="table-wrap"><table><thead><tr><th>Measure</th><th>Old system</th><th>freeDMS</th><th>Result</th></tr></thead><tbody>${metrics.map(([name, old, current]) => `<tr><td>${e(name)}</td><td>${e(old)}</td><td>${e(current)}</td><td>${old === current ? 'Match' : 'Mismatch'}</td></tr>`).join('')}</tbody></table></div>`;
}
function rowTable(rows: MigrationRow[], committed: boolean) {
  return `<div class="table-wrap"><table><thead><tr><th>Data row</th><th>Status</th><th>Reasons and changes</th></tr></thead><tbody>${rows.map(row => `<tr>
    <td>${row.rowNumber}</td><td>${row.status === 'skipped' ? 'Skipped' : committed ? 'Imported' : 'Ready'}</td>
    <td>${row.reasons.map(reason => `<p>${e(reason)}</p>`).join('')}
    ${row.changes.length ? `<ul>${row.changes.map(change => `<li><strong>${e(label(change.field))}</strong> ${e(change.before || '(blank)')} → ${e(change.after || '(blank)')} · ${e(change.reason)}</li>`).join('')}</ul>` : ''}
    ${Object.keys(row.values).length ? `<details><summary>Mapped values</summary><ul>${Object.entries(row.values).map(([field, value]) => `<li>${e(label(field))} · ${e(value)}${['cost', 'listPrice', 'amount'].includes(field) ? ' cents' : ''}</li>`).join('')}</ul></details>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

export async function migrationRoute(ui: UI) {
  if (!ui.admin) {
    ui.shell('<a class="back" href="#/import">← Import inventory</a><h1>Switch from another DMS</h1><p>A workspace administrator manages CSV migrations.</p>');
    return;
  }
  ui.shell(`<a class="back" href="#/import">← Import inventory</a><div class="heading"><div><h1>Switch from another DMS</h1><p class="muted">Upload a CSV export. Review suggested column matches, cleanup and skipped rows before you approve.</p></div></div>
    <form id="migration-form" class="card"><h2>Prepare an import</h2>
      <p>Start with inventory and customers so leads and open deals can link to them. Add leads before deals that reference them.</p>
      <label>Export type<select name="entity">${migrationEntities.map(entity => `<option value="${entity}">${migrationLabels[entity]}</option>`).join('')}</select></label>
      <label>CSV file<input name="csv" type="file" accept=".csv,text/csv" required></label>
      <p id="migration-guidance" class="muted"></p>
      <div class="grid"><label>Expected record count<input name="count" type="number" min="0" step="1" required></label>
        <label id="migration-amount-label"><span></span><input name="amount" type="number" min="0" step="0.01" required></label></div>
      <label id="migration-enrich"><input name="enrich" type="checkbox"> Fill missing vehicle details using VIN decode</label>
      <button class="primary">Preview import</button>
    </form><p id="migration-error" role="alert"></p><div id="migration-preview" aria-live="polite"></div>
    <section class="card"><h2>Import history and parallel-run report</h2><div id="migration-history" aria-live="polite">Loading imports…</div></section>
    <div id="migration-report" aria-live="polite"></div>`);
  const form = document.querySelector<HTMLFormElement>('#migration-form')!;
  const entityInput = form.elements.namedItem('entity') as HTMLSelectElement;
  const fileInput = form.elements.namedItem('csv') as HTMLInputElement;
  const countInput = form.elements.namedItem('count') as HTMLInputElement;
  const amountInput = form.elements.namedItem('amount') as HTMLInputElement;
  const enrichInput = form.elements.namedItem('enrich') as HTMLInputElement;
  const previewOutput = document.querySelector<HTMLElement>('#migration-preview')!;
  const historyOutput = document.querySelector<HTMLElement>('#migration-history')!;
  const reportOutput = document.querySelector<HTMLElement>('#migration-report')!;
  const errorOutput = document.querySelector<HTMLElement>('#migration-error')!;
  let revision = 0;
  let reportRevision = 0;
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
  function updateForm() {
    const entity = entityInput.value as MigrationEntity;
    const amount = document.querySelector<HTMLElement>('#migration-amount-label')!;
    amount.hidden = amountInput.disabled = entity !== 'inventory' && entity !== 'deals';
    amount.querySelector('span')!.textContent = `${amountLabel(entity)} (USD)`;
    const enrich = document.querySelector<HTMLElement>('#migration-enrich')!;
    enrich.hidden = enrichInput.disabled = entity !== 'inventory';
    const guidance: Record<MigrationEntity, string> = {
      inventory: 'Use USD for cost and price. Dates can use YYYY-MM-DD or MM/DD/YYYY.',
      customers: 'Map a full name or name parts. Keep the old customer ID so later files can link to the customer.',
      leads: 'Include the old customer ID, email or phone. VIN or stock number can link a vehicle.',
      deals: 'Include a customer reference, VIN or stock number, and the deal amount in USD. Use the amount you want on the working pencil.'
    };
    document.querySelector('#migration-guidance')!.textContent = `${guidance[entity]} Up to ${migrationBatchLimit} rows per file. Enter totals for this file from the old DMS.`;
  }
  updateForm();
  form.addEventListener('input', () => {
    revision++;
    previewOutput.innerHTML = '';
    errorOutput.textContent = '';
    updateForm();
  });

  async function showReport(ids: string[]) {
    const generation = ++reportRevision;
    reportOutput.innerHTML = '<p>Loading report…</p>';
    try {
      const reports: MigrationImport[] = [];
      for (const id of ids) {
        reports.push(await ui.api<MigrationImport>(`/migration/imports/${id}`));
        if (!ui.current() || generation !== reportRevision) return;
      }
      const sum = (items: MigrationImport[], key: 'expected' | 'actual'): MigrationTotals => ({
        count: items.reduce((count, report) => count + report[key].count, 0),
        ...(items[0][key].amountCents !== undefined ? {amountCents: items.reduce((total, report) => total + (report[key].amountCents ?? 0), 0)} : {})
      });
      const summaries = migrationEntities.flatMap(entity => {
        const items = reports.filter(report => report.entity === entity);
        if (!items.length) return [];
        const expected = sum(items, 'expected'), actual = sum(items, 'actual');
        return [{entity, items, expected, actual, countMatches: expected.count === actual.count,
          ...(expected.amountCents === undefined ? {} : {amountMatches: expected.amountCents === actual.amountCents})}];
      });
      reportOutput.innerHTML = `<section class="card"><div class="heading"><h2>Parallel-run report</h2><button id="migration-download">Download JSON</button></div>
        ${summaries.map(({entity, items, expected, actual}) => {
          return `<h3>${migrationLabels[entity]}</h3>${reconciliation(entity, expected, actual)}
            ${items.map(report => `<details><summary>${e(new Date(report.createdAt).toLocaleString())} · ${report.actual.count} imported · ${report.rows.length - report.actual.count} skipped</summary>
              ${reconciliation(entity, report.expected, report.actual)}<p>Column mapping</p><ul>${report.columns.map(column => `<li>${e(column.header || '(blank header)')} → ${e(column.field ? label(column.field) : column.issue)}</li>`).join('')}</ul>${rowTable(report.rows, true)}</details>`).join('')}`;
        }).join('')}</section>`;
      document.querySelector('#migration-download')!.addEventListener('click', () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify({reconciliation: summaries.map(({items: _, ...summary}) => summary), imports: reports}, null, 2)], {type: 'application/json'}));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'freedms-parallel-run-report.json';
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    } catch (error) {
      if (ui.current() && generation === reportRevision) reportOutput.textContent = errorText(error);
    }
  }

  async function history() {
    const records = await ui.api<MigrationHistory[]>('/migration/imports');
    if (!ui.current()) return;
    historyOutput.innerHTML = records.length ? `<button id="migration-all">View full report</button><ul>${records.map(report =>
      `<li><button class="subtle" data-migration-id="${e(report.id)}">${migrationLabels[report.entity]} · ${e(new Date(report.createdAt).toLocaleString())}</button> ${report.actual.count} imported · ${report.totalRows - report.actual.count} skipped</li>`).join('')}</ul>` : '<p class="empty">No migration imports yet. Prepare a CSV above to get started.</p>';
    historyOutput.querySelector('#migration-all')?.addEventListener('click', () => void showReport(records.map(report => report.id)));
    for (const button of historyOutput.querySelectorAll<HTMLButtonElement>('[data-migration-id]')) {
      button.addEventListener('click', () => void showReport([button.dataset.migrationId!]));
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const generation = ++revision;
    errorOutput.textContent = '';
    previewOutput.innerHTML = '<p>Preparing preview…</p>';
    const entity = entityInput.value as MigrationEntity;
    const endpoint = `/migration/${entity}/import`;
    const file = fileInput.files?.[0];
    if (!file) return;
    const expected = {count: countInput.valueAsNumber, ...(!amountInput.disabled ? {amountCents: Math.round(amountInput.valueAsNumber * 100)} : {})};
    const enrich = !enrichInput.disabled && enrichInput.checked;
    const current = () => ui.current() && generation === revision;
    try {
      const body = {csv: await file.text(), expected, enrich};
      async function render(selected?: (string | null)[]) {
        if (!current()) return;
        const payload = {...body, ...(selected ? {mapping: selected} : {})};
        const preview = await ui.api<MigrationPreview>(`${endpoint}/preview`, 'POST', payload);
        if (!current()) return;
        previewOutput.innerHTML = `<section class="card"><h2>Review column mapping</h2><form id="migration-mapping">
          <div class="table-wrap"><table><thead><tr><th>CSV header</th><th>freeDMS field</th><th>Review</th></tr></thead>
          <tbody>${preview.columns.map((column, i) => `<tr><td id="migration-header-${i}">${e(column.header || '(blank header)')}</td>
            <td><select aria-labelledby="migration-header-${i}"><option value="">Skip this column</option>${preview.fields.map(field =>
            `<option value="${e(field)}" ${field === column.field ? 'selected' : ''}>${e(label(field))}</option>`).join('')}</select></td>
            <td>${e(column.issue ?? 'Mapped')}</td></tr>`).join('')}</tbody></table></div><button>Update preview</button></form>
          <h2>Preview</h2><p>${preview.actual.count} ready · ${preview.rows.length - preview.actual.count} skipped</p>
          ${rowTable(preview.rows, false)}
          <h3>Projected reconciliation</h3>${reconciliation(entity, preview.expected, preview.actual)}
          <button id="migration-confirm" class="primary">${preview.actual.count ? `Approve and import ${recordCount(preview.actual.count)}` : 'Save report for skipped rows'}</button>
        </section>`;
        const mapping = document.querySelector<HTMLFormElement>('#migration-mapping')!;
        const confirm = document.querySelector<HTMLButtonElement>('#migration-confirm')!;
        const picks = [...mapping.querySelectorAll('select')];
        mapping.addEventListener('change', () => { confirm.disabled = true; });
        mapping.addEventListener('submit', async event => {
          event.preventDefault();
          confirm.disabled = true;
          mapping.querySelector('button')!.disabled = true;
          errorOutput.textContent = '';
          try { await render(picks.map(pick => pick.value || null)); }
          catch (error) { if (current()) errorOutput.textContent = errorText(error); }
          finally { mapping.querySelector('button')!.disabled = false; }
        });
        confirm.addEventListener('click', async () => {
          confirm.disabled = true;
          for (const control of [...form.elements, ...mapping.elements]) (control as HTMLInputElement).disabled = true;
          errorOutput.textContent = '';
          try {
            const report = await ui.api<MigrationImport>(endpoint, 'POST', {...payload, approval: preview.approval});
            if (!current()) return;
            previewOutput.innerHTML = `<p role="status">${recordCount(report.actual.count)} imported. See the reconciliation in your report.</p>`;
            await Promise.all([showReport([report.id]), history()]);
          } catch (error) {
            if (current()) { errorOutput.textContent = errorText(error); confirm.disabled = false; }
          } finally {
            for (const control of [...form.elements, ...mapping.elements]) (control as HTMLInputElement).disabled = false;
            if (current()) updateForm();
          }
        });
      }
      await render();
    } catch (error) {
      if (current()) { errorOutput.textContent = errorText(error); previewOutput.innerHTML = ''; }
    }
  });
  try { await history(); } catch (error) { if (ui.current()) historyOutput.textContent = errorText(error); }
}
