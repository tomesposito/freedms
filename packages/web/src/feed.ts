import { fetchAllVehicles } from './vehicles.js';
import { vehicleStatuses, type FeedConfig, type FeedOptions, type FeedRun, type Vehicle } from '@freedms/shared';
import { escapeHtml as e } from './format';
import type { UI } from './desking';
export function feedRunHtml(run: FeedRun): string {
  return `<article class="card"><h3>${e(run.createdAt)}</h3><p>${e(run.includedCount)} included · ${e(run.excludedCount)} excluded</p>${run.formats.map(format => `<button type="button" data-feed-download="${e(run.id)}.${e(format)}">Download ${e(format.toUpperCase())}</button>`).join(' ')}${run.excluded.length ? `<ul>${run.excluded.map(v => `<li>${e(v.stockNumber)} (${e(v.vehicleId)}): ${e(v.message)}</li>`).join('')}</ul>` : '<p>No vehicles excluded.</p>'}</article>`;
}
export async function feedRoute(ui: UI & {download: (path: string, filename: string) => Promise<void>}): Promise<void> {
  ui.shell('<p>Loading feeds…</p>');
  try {
    const [settings, runs, vehicles] = await Promise.all([ui.api<{config: FeedConfig | null; defaults: FeedOptions}>('/feeds/config'), ui.api<FeedRun[]>('/feeds/runs'), fetchAllVehicles<Vehicle>(ui.api)]);
    if (!ui.current()) return;
    const config = settings.config ?? settings.defaults;
    ui.shell(`<h1>Feeds</h1><p>Generic listing files for local download. No partner connection exists and nothing is transmitted to any marketplace. Generation happens when you click Generate. A future hosted scheduler could use the configured cadence; no scheduler runs here.</p>
      ${vehicles.length ? '' : '<p class="empty">No vehicles in inventory. <a href="#/new">Add a vehicle</a> or <a href="#/import">import inventory</a> before generating a populated feed.</p>'}
      <section class="card"><h2>Configuration</h2><p>${settings.config ? `Configured cadence: ${e(config.schedule)}.` : 'No configuration saved yet. Defaults below include priced, available vehicles only. Save to choose your preferences.'}</p>
      <form id="feed-config"><fieldset><legend>Formats</legend>${['csv', 'json'].map(f => `<label><input type="checkbox" name="formats" value="${f}" ${config.formats.includes(f as 'csv' | 'json') ? 'checked' : ''}>${f.toUpperCase()}</label>`).join('')}</fieldset>
      <fieldset><legend>Included statuses</legend>${vehicleStatuses.map(s => `<label><input type="checkbox" name="includedStatuses" value="${e(s)}" ${config.includedStatuses.includes(s) ? 'checked' : ''}>${e(s)}</label>`).join('')}</fieldset>
      <label><input type="checkbox" name="requirePrice" ${config.requirePrice ? 'checked' : ''}>Require a positive list price</label><label>Cadence preference<select name="schedule">${['manual', 'daily', 'weekly'].map(s => `<option value="${s}" ${config.schedule === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select></label><button>Save configuration</button></form></section>
      <p>Generate uses the saved configuration, or defaults if none is saved. Save form changes first. CSV prices are USD dollars; JSON uses listPriceCents. Internal costs and notes are excluded.</p><button id="feed-generate" class="primary">Generate feed</button>
      <section><h2>Last run</h2>${runs.length ? feedRunHtml(runs[0]) : '<p>No runs yet. Click Generate to create a downloadable snapshot and exclusion log.</p>'}</section><section><h2>Run history</h2>${runs.length > 1 ? runs.slice(1).map(feedRunHtml).join('') : '<p>No earlier runs.</p>'}</section>`);
    const form = document.querySelector<HTMLFormElement>('#feed-config')!;
    form.addEventListener('submit', async event => {
      event.preventDefault(); const button = form.querySelector('button')!; button.disabled = true;
      const data = new FormData(form);
      try { await ui.api('/feeds/config', 'PUT', {formats: data.getAll('formats'), includedStatuses: data.getAll('includedStatuses'), requirePrice: data.has('requirePrice'), schedule: data.get('schedule')}); if (ui.current()) ui.refresh(); }
      catch (error) { if (ui.current()) ui.flash(error); }
      finally { button.disabled = false; }
    });
    document.querySelector<HTMLButtonElement>('#feed-generate')!.addEventListener('click', async event => {
      const button = event.currentTarget as HTMLButtonElement; button.disabled = true;
      try { await ui.api('/feeds/generate', 'POST', {}); if (ui.current()) ui.refresh(); }
      catch (error) { if (ui.current()) ui.flash(error); }
      finally { button.disabled = false; }
    });
    document.querySelectorAll<HTMLButtonElement>('[data-feed-download]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true; const file = button.dataset.feedDownload!;
      try { await ui.download(`/feeds/runs/${file}`, `feed-${file}`); }
      catch (error) { if (ui.current()) ui.flash(error); }
      finally { button.disabled = false; }
    }));
  } catch (error) { if (ui.current()) ui.flash(error); }
}
