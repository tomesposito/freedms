import { fetchAllVehicles } from './vehicles.js';
import { vehicleStatuses, type AgreementGatedDestination, type DestinationFeedStatus, type FacebookFeedStatus, type FeedConfig, type FeedOptions, type FeedRun, type Vehicle } from '@freedms/shared';
import { escapeHtml as e } from './format';
import type { UI } from './desking';
export function feedRunHtml(run: FeedRun): string {
  return `<article class="card"><h3>${e(run.createdAt)}</h3><p>${e(run.includedCount)} included · ${e(run.excludedCount)} excluded</p>${run.formats.map(format => `<button type="button" data-feed-download="${e(run.id)}.${e(format)}">Download ${e(format.toUpperCase())}</button>`).join(' ')}${run.excluded.length ? `<ul>${run.excluded.map(v => `<li>${e(v.stockNumber)} (${e(v.vehicleId)}): ${e(v.message)}</li>`).join('')}</ul>` : '<p>No vehicles excluded.</p>'}</article>`;
}
export function facebookFeedHtml(facebook: FacebookFeedStatus, tenantId: string): string {
  return `<section class="card"><h2>Facebook Marketplace</h2><p>${facebook.enabled ? 'Enabled' : 'Disabled'}</p><label>Feed URL for tenant ${e(tenantId)}<input readonly value="${e(facebook.feedUrl)}" aria-label="Facebook feed URL"></label><p>${facebook.lastGeneratedAt === null ? 'Not generated yet — enable it and click Generate feed.' : `Last generated: ${e(facebook.lastGeneratedAt)} · ${e(facebook.vehicleCount ?? 0)} vehicles`}</p><p>Enable Facebook Marketplace, save configuration, and click Generate feed. In Meta Commerce Manager → Catalog → Data feeds, add the URL on a schedule. When hosted, Meta pulls this URL; freeDMS does not transmit inventory. Sold or removed vehicles drop out of the feed right away, without waiting for the next generation. Free with the DMS.</p><p>Meta controls catalog approval, eligibility, and ranking; freeDMS ships a correct feed and these steps; placement is never promised. Eligibility depends on country, account type, and page standing.</p></section>`;
}
const destinationSteps: Record<string, string> = {
  google: 'Enable Google Vehicle Ads, save configuration, and click Generate feed. In Google Merchant Center, register a vehicle ads data source and add this URL as a scheduled fetch. When hosted, Google pulls this URL; freeDMS does not transmit inventory. Sold or removed vehicles drop out of the feed right away, without waiting for the next generation. Free with the DMS. Google requires an exterior color for each vehicle; freeDMS does not record color, so that column ships empty and Google may disapprove a row until the color is supplied in Merchant Center.',
  syndication: 'Enable the syndication CSV, save configuration, and click Generate feed. Give this URL to your listing provider or aggregator — it carries the standard inventory fields (VIN, stock, year, make, model, trim, price, mileage, description, and photo URLs) in the layout dealer feed providers use for Carsforsale.com-style ingestion. They pull it on their schedule; freeDMS does not transmit inventory. Sold or removed vehicles drop out of the feed right away, without waiting for the next generation. Free with the DMS.',
};
const destinationLimits: Record<string, string> = {
  google: 'Google controls vehicle ads approval, eligibility, and ranking; freeDMS ships a feed in Google\'s published format and these steps; placement is never promised. Vehicle ads availability depends on country and account standing.',
  syndication: 'Your provider or aggregator controls approval, ranking, and placement; freeDMS ships a correct feed and this URL; placement is never promised.',
};
export function destinationFeedHtml(destination: DestinationFeedStatus, tenantId: string): string {
  return `<section class="card"><h2>${e(destination.name)}</h2><p>${destination.enabled ? 'Enabled' : 'Disabled'}</p><label>Feed URL for tenant ${e(tenantId)}<input readonly value="${e(destination.feedUrl)}" aria-label="${e(destination.name)} feed URL"></label><p>${destination.lastGeneratedAt === null ? 'Not generated yet — enable it and click Generate feed.' : `Last generated: ${e(destination.lastGeneratedAt)} · ${e(destination.vehicleCount ?? 0)} vehicles`}</p><p>${e(destinationSteps[destination.id] ?? '')}</p><p>${e(destinationLimits[destination.id] ?? '')}</p></section>`;
}
export function agreementGatedHtml(gated: AgreementGatedDestination[]): string {
  return `<section class="card"><h2>Agreement-gated destinations</h2><p>These marketplaces do not accept a feed a dealer can pull or hand over directly, so freeDMS does not offer a feed URL for them. They are tracked with direct posting in the parent roadmap item.</p><ul>${gated.map(g => `<li><b>${e(g.name)}</b> — ${e(g.note)}</li>`).join('')}</ul></section>`;
}
export async function feedRoute(ui: UI & {download: (path: string, filename: string) => Promise<void>}): Promise<void> {
  ui.shell('<p>Loading feeds…</p>');
  try {
    const [settings, runs, vehicles] = await Promise.all([ui.api<{config: FeedConfig | null; defaults: FeedOptions; facebook: FacebookFeedStatus; destinations: DestinationFeedStatus[]; agreementGated: AgreementGatedDestination[]}>('/feeds/config'), ui.api<FeedRun[]>('/feeds/runs'), fetchAllVehicles<Vehicle>(ui.api)]);
    if (!ui.current()) return;
    const config = settings.config ?? settings.defaults;
    ui.shell(`<h1>Feeds</h1><p>Generic listing files for local download. Nothing is transmitted by freeDMS; Meta can pull the enabled Facebook feed URL when hosted. Generation happens when you click Generate. A future hosted scheduler could use the configured cadence; no scheduler runs here.</p>
      ${vehicles.length ? '' : '<p class="empty">No vehicles in inventory. <a href="#/new">Add a vehicle</a> or <a href="#/import">import inventory</a> before generating a populated feed.</p>'}
      <section class="card"><h2>Configuration</h2><p>${settings.config ? `Configured cadence: ${e(config.schedule)}.` : 'No configuration saved yet. Defaults below include priced, available vehicles only. Save to choose your preferences.'}</p>
      <form id="feed-config"><fieldset><legend>Formats</legend>${['csv', 'json'].map(f => `<label><input type="checkbox" name="formats" value="${f}" ${config.formats.includes(f as 'csv' | 'json') ? 'checked' : ''}>${f.toUpperCase()}</label>`).join('')}</fieldset>
      <fieldset><legend>Included statuses</legend>${vehicleStatuses.map(s => `<label><input type="checkbox" name="includedStatuses" value="${e(s)}" ${config.includedStatuses.includes(s) ? 'checked' : ''}>${e(s)}</label>`).join('')}</fieldset>
      <label><input type="checkbox" name="requirePrice" ${config.requirePrice ? 'checked' : ''}>Require a positive list price</label><label>Cadence preference<select name="schedule">${['manual', 'daily', 'weekly'].map(s => `<option value="${s}" ${config.schedule === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select></label><fieldset><legend>Destinations</legend><label><input type="checkbox" name="facebookEnabled" ${config.facebookEnabled ? 'checked' : ''}>Enable Facebook Marketplace feed</label><label><input type="checkbox" name="googleEnabled" ${config.googleEnabled ? 'checked' : ''}>Enable Google Vehicle Ads feed</label><label><input type="checkbox" name="syndicationEnabled" ${config.syndicationEnabled ? 'checked' : ''}>Enable syndication CSV feed</label></fieldset><button>Save configuration</button></form></section>
      <p>Generate uses the saved configuration, or defaults if none is saved. Save form changes first. CSV prices are USD dollars; JSON uses listPriceCents. Internal costs and notes are excluded.</p><button id="feed-generate" class="primary">Generate feed</button>
      ${facebookFeedHtml(settings.facebook, settings.facebook.feedUrl.split('/')[2])}
      ${settings.destinations.filter(d => d.id !== 'facebook').map(d => destinationFeedHtml(d, d.feedUrl.split('/')[2])).join('')}
      ${agreementGatedHtml(settings.agreementGated)}
      <section><h2>Last run</h2>${runs.length ? feedRunHtml(runs[0]) : '<p>No runs yet. Click Generate to create a downloadable snapshot and exclusion log.</p>'}</section><section><h2>Run history</h2>${runs.length > 1 ? runs.slice(1).map(feedRunHtml).join('') : '<p>No earlier runs.</p>'}</section>`);
    const form = document.querySelector<HTMLFormElement>('#feed-config')!;
    form.addEventListener('submit', async event => {
      event.preventDefault(); const button = form.querySelector('button')!; button.disabled = true;
      const data = new FormData(form);
      try { await ui.api('/feeds/config', 'PUT', {formats: data.getAll('formats'), includedStatuses: data.getAll('includedStatuses'), requirePrice: data.has('requirePrice'), facebookEnabled: data.has('facebookEnabled'), googleEnabled: data.has('googleEnabled'), syndicationEnabled: data.has('syndicationEnabled'), schedule: data.get('schedule')}); if (ui.current()) ui.refresh(); }
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
