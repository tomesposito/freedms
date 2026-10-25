import { catalogPage, skillOptions, inspectionHtml, inspectionRow, inspectionResults, bindInspection } from './service-depth';
import { journalHtml } from './accounting';
import type { JournalView } from '@freedms/shared';
import { appointmentStatuses, appointmentStatusLabels, repairOrderPayTypes, repairOrderPayTypeLabels, repairOrderStatuses, repairOrderStatusLabels, repairOrderTotals, lineItemAmountCents, serviceSkills, type Technician, type LaborRate, type ServiceSkill, type InspectionItem, type Part, type ServiceBoardDay, type ServiceAppointment, type RepairOrderView, type RepairOrderLineItem, type User, type Customer, type VehicleView } from '@freedms/shared';
import { escapeHtml as e, currency, cents } from './format';
import type { UI } from './desking';
const link = (r: RepairOrderView) => `#/service/repair-orders/${encodeURIComponent(r.id)}`;
export function serviceHistoryHtml(rows: RepairOrderView[]): string {
  return rows.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Customer / concern</th><th>Status</th><th>Pay type</th><th>Total</th></tr></thead><tbody>${rows.map(r => `<tr><td><a href="${link(r)}">${e(r.createdAt.slice(0,10))}</a></td><td>${e(r.customerName)}<p>${e(r.concern)}</p></td><td>${e(repairOrderStatusLabels[r.status])}</td><td>${e(repairOrderPayTypeLabels[r.payType])}</td><td>${currency(repairOrderTotals(r.lineItems).totalCents)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No service history yet.</p>';
}
export function serviceBoardHtml(day: ServiceBoardDay, users: User[] = []): string {
  return `<h1>Service board</h1><p><a href="#/service/settings">Technicians and labor grid</a></p><section class="card"><h2>Technician day load</h2><p>Count of appointments plus repair orders for this UTC day.</p>${day.technicians?.length ? day.technicians.map(t=>`<p>${e(t.name)}: ${t.dayLoad}</p>`).join('') : '<p class="empty">No technicians yet.</p>'}</section><form id="service-date"><label>Day (UTC)<input name="date" type="date" required value="${e(day.date)}"></label><button>Show day</button></form><p><a class="button" href="#/service/appointments/new">Schedule appointment</a> <a class="button" href="#/service/repair-orders/new">Open walk-in repair order</a></p>${day.appointments.length ? '' : '<p class="empty">No service appointments for this day</p>'}<div class="service-board">${appointmentStatuses.map(status => `<section class="card"><h2>${appointmentStatusLabels[status]} (${day.byStatus[status].length})</h2>${day.byStatus[status].map(a => `<article><h3><a href="#/service/appointments/${encodeURIComponent(a.id)}">${e(a.customerName)}</a></h3><p>${e(new Date(a.scheduledStart).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}))}–${e(new Date(a.scheduledEnd).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}))}</p><p>${e(a.vehicleDescription)}</p><p>Technician: ${e(day.technicians?.find(t=>t.id===a.technicianId)?.name ?? 'Unassigned')}</p><p>Advisor: ${e(users.find(u => u.id === a.advisorId)?.name ?? a.advisorId ?? 'Unassigned')}</p><p>${e(a.concern.slice(0,200))}</p></article>`).join('')}</section>`).join('')}</div><section class="card"><h2>Repair orders for this day</h2>${day.repairOrders.map(r=>`<p><a href="${link(r)}">${e(r.customerName)}</a> · Technician: ${e(day.technicians?.find(t=>t.id===r.technicianId)?.name ?? 'Unassigned')}</p>`).join('')}${serviceHistoryHtml(day.repairOrders)}</section>`;
}
export function repairOrderLinesHtml(items: RepairOrderLineItem[]): string {
  const totals = repairOrderTotals(items);
  return `<table><thead><tr><th>Type</th><th>Description</th><th>Hours / quantity</th><th>Rate / price</th><th>Amount</th></tr></thead><tbody>${items.map(i => `<tr><td>${e(i.kind)}</td><td>${e(i.description)}</td><td>${i.kind === 'labor' ? (i.laborHoursHundredths! / 100).toFixed(2) : i.quantity}</td><td>${currency(i.kind === 'labor' ? i.laborRateCents! : i.unitPriceCents!)}</td><td>${currency(lineItemAmountCents(i))}</td></tr>`).join('')}</tbody></table><p>Labor: ${currency(totals.laborCents)} · Parts: ${currency(totals.partsCents)} · <strong>Total: ${currency(totals.totalCents)}</strong></p>`;
}
const input = (label: string, name: string, value: unknown, attrs = '') => `<label>${e(label)}<input name="${e(name)}" value="${e(value)}" ${attrs}></label>`;
const select = (label: string, name: string, values: {id:string; name:string}[], selected: string | null, optional = true) => `<label>${e(label)}<select name="${e(name)}" ${optional ? '' : 'required'}>${optional ? '<option value="">Unassigned</option>' : `<option value="">Choose ${e(label.toLowerCase())}</option>`}${values.map(v => `<option value="${e(v.id)}" ${v.id === selected ? 'selected' : ''}>${e(v.name)}</option>`).join('')}</select></label>`;
const choices = (label: string, name: string, values: readonly string[], labels: Record<string,string>, value: string) => select(label,name,values.map(id => ({id,name:labels[id]})),value,false);
function localInput(iso?: string): string { if (!iso) return ''; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,16); }
export function rowHtml(i: RepairOrderLineItem, catalog: Part[] = []): string {
  return `<fieldset data-line="${e(i.id)}" data-kind="${i.kind}"><legend>${i.kind === 'labor' ? 'Labor' : 'Parts'}</legend>${i.kind === 'parts' ? `<label class="stock-picker">Stocked part<select name="partId"><option value="">Free-text part</option>${catalog.map(p=>`<option value="${e(p.id)}" ${p.id===i.partId ? 'selected' : ''}>${e(p.partNumber)} · ${e(p.description)}</option>`).join('')}</select></label><p data-stock-hint>${i.partId ? `${catalog.find(p=>p.id===i.partId)?.quantityOnHand ?? 'Unknown'} on hand` : 'Free-text lines do not affect stock.'}</p>` : ''}${input('Description','description',i.description,'required maxlength="200"')}${i.kind === 'labor' ? `<label>Skill / job type<select name="skill"><option value="">No grid rate</option>${skillOptions(i.skill)}</select></label>` + input('Hours','hours',(i.laborHoursHundredths! / 100).toFixed(2),'type="number" min="0.01" max="1000" step="0.01" required') + input('Rate (USD/hour)','rate',(i.laborRateCents! / 100).toFixed(2),'type="number" min="0" step="0.01" required') : input('Quantity','quantity',i.quantity,'type="number" min="1" max="100000" step="1" required') + input('Unit price (USD)','price',(i.unitPriceCents! / 100).toFixed(2),'type="number" min="0" step="0.01" required')}<button type="button" data-remove>Remove line</button></fieldset>`;
}
export async function serviceRoute(parts: string[], ui: UI): Promise<void> {
  if (parts[1] === 'settings') { await catalogPage(ui); return; }
  if (!parts[1]) {
    let generation = 0;
    const render = async (date: string) => {
      const current = ++generation;
      const [day,users] = await Promise.all([ui.api<ServiceBoardDay>(`/service/board?date=${encodeURIComponent(date)}`),ui.api<User[]>('/users')]);
      if (!ui.current() || current !== generation) return; ui.shell(serviceBoardHtml(day,users));
      document.querySelector<HTMLFormElement>('#service-date')!.onsubmit = event => { event.preventDefault(); void render(String(new FormData(event.currentTarget as HTMLFormElement).get('date'))).catch(ui.flash); };
    };
    await render(new Date().toISOString().slice(0,10)); return;
  }
  if (parts[1] === 'history' && ['vehicle','customer'].includes(parts[2]) && parts[3]) {
    const rows = await ui.api<RepairOrderView[]>(`/service/repair-orders?${parts[2]}Id=${encodeURIComponent(parts[3])}`);
    if (ui.current()) ui.shell(`<a href="#/service">← Service</a><h1>Service history</h1>${serviceHistoryHtml(rows)}`); return;
  }
  const appt = parts[1] === 'appointments';
  if (!['appointments','repair-orders'].includes(parts[1]) || !parts[2]) throw new Error('Service page not found.');
  const creating = parts[2] === 'new', base = `/service/${parts[1]}`;
  const [customers,vehicles,users,record,appointment,catalog,journal,technicians,rates] = await Promise.all([
    ui.api<Customer[]>('/customers'),ui.api<VehicleView[]>('/vehicles'),ui.api<User[]>('/users'),
    creating ? undefined : ui.api<ServiceAppointment | RepairOrderView>(`${base}/${encodeURIComponent(parts[2])}`),
    creating && !appt && parts[3] ? ui.api<ServiceAppointment>(`/service/appointments/${encodeURIComponent(parts[3])}`) : undefined,
    appt ? [] : ui.api<Part[]>('/parts'),
    creating || appt ? [] : ui.api<JournalView[]>(`/accounting/journal?repairOrderId=${encodeURIComponent(parts[2])}`),
    ui.api<Technician[]>('/service/technicians'),ui.api<LaborRate[]>('/service/labor-rates')
  ]);
  if (!ui.current()) return;
  const source = record ?? appointment, ro = record?.kind === 'repair-order' ? record : undefined, a = record?.kind === 'service-appointment' ? record : undefined;
  ui.shell(`<a href="#/service">← Service board</a><h1>${creating ? 'New' : 'Edit'} ${appt ? 'service appointment' : 'repair order'}</h1>${a ? `<p><a class="button" href="#/service/repair-orders/new/${encodeURIComponent(a.id)}">Open repair order</a></p>` : ''}${!customers.length ? '<p>Add a customer from <a href="#/leads/new">Leads</a> before scheduling service.</p>' : ''}<form id="service-form"><section class="card"><div class="form-grid">${creating && !appointment ? select('Customer','customerId',customers, null,false) : `<p>Customer: ${e(source?.customerName)}</p>`}${select('Vehicle','vehicleId',vehicles.map(v => ({id:v.id,name:`${v.year} ${v.make} ${v.model}`})),source?.vehicleId ?? null)}${input('Vehicle description','vehicleDescription',source?.vehicleDescription ?? '', 'maxlength="1000"')}${select('Technician','technicianId',technicians,source?.technicianId ?? null)}${select('Required skill','requiredSkill',serviceSkills.map(id=>({id,name:id})),source?.requiredSkill ?? null)}<label id="skill-override" hidden><span id="skill-warning"></span><input name="acknowledgeSkillMismatch" type="checkbox">I acknowledge this skill mismatch</label>${source?.skillMismatchWarning?`<p>Recorded override: ${e(source.skillMismatchWarning.requiredSkill)} · ${e(source.skillMismatchWarning.acknowledgedBy)} · ${e(source.skillMismatchWarning.acknowledgedAt)}</p>`:''}${select('Advisor','advisorId',users,source?.advisorId ?? null)}${appt ? input('Start','scheduledStart',localInput(a?.scheduledStart),'type="datetime-local" required') + input('End','scheduledEnd',localInput(a?.scheduledEnd),'type="datetime-local" required') : choices('Pay type','payType',repairOrderPayTypes,repairOrderPayTypeLabels,ro?.payType ?? 'customer-pay')}${record ? appt ? choices('Status','status',appointmentStatuses,appointmentStatusLabels,a!.status) : choices('Status','status',repairOrderStatuses,repairOrderStatusLabels,ro!.status) : ''}</div><label>Concern<textarea name="concern" maxlength="2000">${e(source?.concern ?? '')}</textarea></label></section>${!appt ? `<section class="card"><h2>Line items</h2><p>Stock applied: ${ro?.stockApplied ? 'Yes' : 'No'}</p>${ro?.stockWarning ? `<p role="alert">${e(ro.stockWarning)}</p>` : ''}<p>Stocked parts deplete on completion and restore when reopened. Free-text parts do not affect stock.</p><div id="service-lines">${(ro?.lineItems ?? []).map(i=>rowHtml(i,catalog)).join('')}</div><button type="button" data-add="labor">Add labor</button> <button type="button" data-add="parts">Add parts</button><div id="service-totals" aria-live="polite">${repairOrderLinesHtml(ro?.lineItems ?? [])}</div></section>` : ''}${!appt ? inspectionHtml(ro,catalog) : ''}${ro ? '<label id="stock-override" class="stock-override" hidden><input type="checkbox" name="allowNegativeStock"> Explicitly allow negative stock</label>' : ''}<button>Save ${appt ? 'appointment' : 'repair order'}</button></form>${ro ? inspectionResults(ro) : ''}${!appt ? `<section class="card"><h2>Accounting</h2>${journal.length ? journalHtml(journal, false) : '<p class="empty">No journal entries yet — finalize this repair order to post it.</p>'}</section>` : ''}`);
  const form = document.querySelector<HTMLFormElement>('#service-form')!;
  const updateMismatch = () => {
    const tech = technicians.find(t=>t.id===form.querySelector<HTMLSelectElement>('[name="technicianId"]')!.value);
    const skill = form.querySelector<HTMLSelectElement>('[name="requiredSkill"]')!.value as ServiceSkill;
    const mismatch = !!tech && !!skill && !tech.skills.includes(skill);
    const label = form.querySelector<HTMLElement>('#skill-override')!, box=label.querySelector<HTMLInputElement>('input')!;
    label.hidden=!mismatch; box.required=mismatch; box.checked=false;
    form.querySelector('#skill-warning')!.textContent=mismatch?`${tech!.name} does not have required skill ${skill}. `:'';
  };
  updateMismatch();
  form.addEventListener('change',event=>{if(['technicianId','requiredSkill'].includes((event.target as HTMLSelectElement).name))updateMismatch();});
  if(ro) bindInspection(ro,ui);
  if(!appt) document.querySelector<HTMLButtonElement>('#add-inspection')!.onclick=()=>{
    if(form.querySelectorAll('[data-inspection]').length>=100){ui.flash(new Error('At most 100 inspection items.'));return;}
    document.querySelector('#inspection-items')!.insertAdjacentHTML('beforeend',inspectionRow({id:crypto.randomUUID(),label:'',status:'ok',skill:'general',laborHoursHundredths:100,partId:null},catalog));
  };
  const readLines = (): RepairOrderLineItem[] => Array.from(form.querySelectorAll<HTMLFieldSetElement>('[data-line]')).map(row => {
    const value = (name: string) => row.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value;
    const labor = row.dataset.kind === 'labor';
    return {skill:labor ? value('skill') as ServiceSkill || null : null,partId:labor ? null:value('partId')||null,id:row.dataset.line!,kind:labor ? 'labor':'parts',description:value('description'),laborHoursHundredths:labor ? cents(value('hours')):null,laborRateCents:labor ? cents(value('rate')):null,quantity:labor ? null:Number(value('quantity')),unitPriceCents:labor ? null:cents(value('price'))};
  });
  const totals = () => { try { document.querySelector('#service-totals')!.innerHTML = repairOrderLinesHtml(readLines()); } catch { document.querySelector('#service-totals')!.textContent = 'Enter valid hours, quantities and prices to calculate totals.'; } };
  if (!appt) {
    const override = form.querySelector<HTMLElement>('#stock-override');
    const updateOverride = () => { if(override) { override.hidden = !['completed','picked-up'].includes(form.querySelector<HTMLSelectElement>('[name="status"]')!.value); if(override.hidden) override.querySelector<HTMLInputElement>('input')!.checked=false; } };
    updateOverride();
    form.addEventListener('change',event=>{
      const target=event.target as HTMLSelectElement;
      if(target.name==='status') updateOverride();
      if(target.name==='skill') {
        const rate=rates.find(r=>r.skill===target.value);
        if(rate) target.closest('fieldset')!.querySelector<HTMLInputElement>('[name="rate"]')!.value=(rate.laborRateCents/100).toFixed(2);
        else if(target.value) ui.flash(new Error('No grid rate configured for this skill. Enter a manual rate or configure the labor grid.'));
        totals();
      }
      if(target.name==='partId') {
        const row=target.closest('fieldset')!, part=catalog.find(p=>p.id===target.value);
        row.querySelector('[data-stock-hint]')!.textContent=part ? `${part.quantityOnHand} on hand` : 'Free-text lines do not affect stock.';
        if(part) { row.querySelector<HTMLInputElement>('[name="description"]')!.value=part.description; row.querySelector<HTMLInputElement>('[name="price"]')!.value=(part.retailPriceCents/100).toFixed(2); } totals();
      }
    });
    form.addEventListener('input',totals);
    form.addEventListener('click',event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button'); if (!button) return;
      if (button.hasAttribute('data-remove')) { button.closest('fieldset')!.remove(); totals(); }
      if (button.dataset.add) {
        if (form.querySelectorAll('[data-line]').length >= 100) { ui.flash(new Error('At most 100 line items.')); return; }
        const labor = button.dataset.add === 'labor';
        document.querySelector('#service-lines')!.insertAdjacentHTML('beforeend',rowHtml({id:crypto.randomUUID(),kind:labor?'labor':'parts',description:'',laborHoursHundredths:labor?100:null,laborRateCents:labor?0:null,quantity:labor?null:1,unitPriceCents:labor?null:0},catalog)); totals();
      }
    });
  }
  let saving = false;
  form.onsubmit = async event => {
    event.preventDefault(); if (saving) return; saving = true;
    try {
      const data = new FormData(form), body: Record<string,unknown> = {};
      for (const key of ['technicianId','requiredSkill','vehicleId','vehicleDescription','advisorId','concern',...(appt ? ['scheduledStart','scheduledEnd'] : ['payType']),...(record ? ['status'] : [])]) body[key] = String(data.get(key) ?? '');
      if(ro && ['completed','picked-up'].includes(String(body.status)) && data.has('allowNegativeStock')) body.allowNegativeStock=true;
      if(data.has('acknowledgeSkillMismatch'))body.acknowledgeSkillMismatch=true;
      body.technicianId ||= null; body.requiredSkill ||= null;
      body.vehicleId ||= null; body.advisorId ||= null;
      if (record) body.version = record.version; else if (appointment) body.appointmentId = appointment.id; else body.customerId = String(data.get('customerId') ?? '');
      if (appt) { body.scheduledStart = new Date(String(body.scheduledStart)).toISOString(); body.scheduledEnd = new Date(String(body.scheduledEnd)).toISOString(); } else {
        body.lineItems = readLines();
        body.inspection=Array.from(form.querySelectorAll<HTMLFieldSetElement>('[data-inspection]')).map(row=>{
          const val=(name:string)=>row.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value;
          return {id:row.dataset.inspection,label:val('label'),status:val('inspectionStatus'),skill:val('inspectionSkill'),laborHoursHundredths:cents(val('inspectionHours')),partId:val('inspectionPart')||null} as InspectionItem;
        });
      }
      const saved = await ui.api<ServiceAppointment | RepairOrderView>(record ? `${base}/${encodeURIComponent(record.id)}` : base, record ? 'PUT':'POST',body);
      if (ui.current()) { if (record) ui.refresh(); else location.hash = `#/service/${parts[1]}/${saved.id}`; }
    } catch(error) { if (ui.current()) ui.flash(error); } finally { saving = false; }
  };
}
