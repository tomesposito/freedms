import type { WebsiteSettings } from '@freedms/shared';
import type { UI } from './desking';
import { escapeHtml as e } from './format';
export function websiteSettingsHtml(s: Pick<WebsiteSettings, 'storeName' | 'logoUrl' | 'phone' | 'address' | 'hours' | 'about' | 'primaryColor' | 'storePhotoUrl'> & {siteUrl: string}) {
  return `<a class="back" href="#/deals/settings">← Workspace settings</a><h1>Website</h1><p>Your website is free with the DMS. Inventory and prices update live. These are the only site controls; all five pages are included.</p><p><a href="${e(s.siteUrl)}" target="_blank" rel="noopener">View your public website</a></p><form id="website-settings" class="card"><div class="form-grid">${[['storeName', 'Store name'], ['phone', 'Phone'], ['address', 'Address'], ['hours', 'Hours'], ['logoUrl', 'Logo URL'], ['storePhotoUrl', 'Store photo URL'], ['primaryColor', 'Primary color']].map(([key, label]) => `<label>${label}<input name="${key}" value="${e(s[key as keyof typeof s])}" ${key.endsWith('Url') ? 'type="url"' : key === 'primaryColor' ? 'type="color" required' : ''} maxlength="${key.endsWith('Url') ? 2000 : 500}"></label>`).join('')}</div><label>About your store<textarea name="about" maxlength="2000" rows="5">${e(s.about)}</textarea></label><p>Leave store name, phone, or address blank to use your workspace identity. Use HTTP(S) image URLs. Hours and about text appear as written.</p><button class="primary">Save website</button><p id="website-saved" role="status"></p></form>`;
}
export async function websiteRoute(ui: UI) {
  if (!ui.admin) { ui.shell('<h1>Website</h1><p>Only administrators can manage the website.</p>'); return; }
  const s = await ui.api<WebsiteSettings & {siteUrl: string}>('/settings/website'); if (!ui.current()) return;
  ui.shell(websiteSettingsHtml(s));
  const form = document.querySelector<HTMLFormElement>('#website-settings')!;
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = form.querySelector('button')!; button.disabled = true;
    try {
      const saved = await ui.api<WebsiteSettings>('/settings/website', 'PUT', {...Object.fromEntries(new FormData(form)), version: s.version});
      s.version = saved.version;
      if (ui.current()) document.querySelector('#website-saved')!.textContent = 'Website saved. Your public pages now use these settings.';
    } catch (error) { if (ui.current()) ui.flash(error); }
    finally { button.disabled = false; }
  });
}
