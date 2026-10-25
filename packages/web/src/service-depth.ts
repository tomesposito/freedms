import { serviceSkills, maxDocumentBytes, type Technician, type LaborRate, type RepairOrderView, type Part, type InspectionItem } from '@freedms/shared';
import { escapeHtml as e, currency, cents } from './format';
import type { UI } from './desking';
export const skillOptions = (selected?: string | null) => serviceSkills.map(s=>`<option ${s===selected?'selected':''} value="${s}">${s}</option>`).join('');
export async function catalogPage(ui: UI) {
  const [techs,rates] = await Promise.all([ui.api<Technician[]>('/service/technicians'),ui.api<LaborRate[]>('/service/labor-rates')]);
  if (!ui.current()) return;
  const techForm = (t?: Technician) => `<form data-tech="${e(t?.id ?? '')}"><label>Name<input name="name" required maxlength="120" value="${e(t?.name ?? '')}"></label><fieldset><legend>Skills</legend>${serviceSkills.map(s=>`<label><input type="checkbox" name="skills" value="${s}" ${t?.skills.includes(s)?'checked':''}>${s}</label>`).join('')}</fieldset><button>${t?'Update technician':'Add technician'}</button></form>`;
  ui.shell(`<a href="#/service">← Service board</a><h1>Technicians and labor grid</h1><section class="card"><h2>Technicians</h2>${techs.length?techs.map(techForm).join(''):'<p class="empty">No technicians yet.</p>'}${techForm()}</section><section class="card"><h2>Labor grid</h2><p>Rates per hour. RO labor rates remain editable.</p>${!rates.length?'<p class="empty">No labor rates configured.</p>':''}${serviceSkills.map(s=>{const r=rates.find(r=>r.skill===s);return `<form data-rate="${s}"><label>${s} (USD/hour)<input name="rate" type="number" min="0" step="0.01" required value="${r?(r.laborRateCents/100).toFixed(2):''}"></label><button>Save rate</button></form>`;}).join('')}</section>`);
  document.querySelectorAll<HTMLFormElement>('[data-tech], [data-rate]').forEach(form=>form.onsubmit=async event=>{
    event.preventDefault(); const button=form.querySelector('button')!; button.disabled=true;
    try { const data=new FormData(form);
      if (form.hasAttribute('data-tech')) {
        const old=techs.find(t=>t.id===form.dataset.tech);
        await ui.api(`/service/technicians${old?`/${old.id}`:''}`,old?'PUT':'POST',{name:data.get('name'),skills:data.getAll('skills'),...(old?{version:old.version}:{})});
      } else {
        const old=rates.find(r=>r.skill===form.dataset.rate);
        await ui.api(`/service/labor-rates${old?`/${old.id}`:''}`,old?'PUT':'POST',{skill:form.dataset.rate,laborRateCents:cents(String(data.get('rate'))),...(old?{version:old.version}:{})});
      }
      if(ui.current()) ui.refresh();
    } catch(error) { ui.flash(error); } finally { button.disabled=false; }
  });
}
export function inspectionRow(i: InspectionItem, catalog: Part[]) {
  return `<fieldset data-inspection="${e(i.id)}"><label>Item<input name="label" maxlength="200" required value="${e(i.label)}"></label><label>Status<select name="inspectionStatus">${['ok','monitor','needs-attention'].map(s=>`<option ${s===i.status?'selected':''}>${s}</option>`).join('')}</select></label><label>Skill<select name="inspectionSkill">${skillOptions(i.skill)}</select></label><label>Hours<input name="inspectionHours" type="number" min="0.01" max="1000" step="0.01" required value="${i.laborHoursHundredths/100}"></label><label>Part (one unit)<select name="inspectionPart"><option value="">No part</option>${catalog.map(p=>`<option value="${e(p.id)}" ${p.id===i.partId?'selected':''}>${e(p.description)} · ${currency(p.retailPriceCents)}</option>`).join('')}</select></label></fieldset>`;
}
export function inspectionHtml(ro: RepairOrderView | undefined,catalog: Part[]) {
  return `<section class="card"><h2>Inspection checklist</h2>${ro?.inspection?.length?'':'<p class="empty">No inspection items yet.</p>'}<div id="inspection-items">${(ro?.inspection??[]).map(i=>inspectionRow(i,catalog)).join('')}</div><button type="button" id="add-inspection">Add inspection item</button><p>Needs-attention items produce a recommendation using the configured labor rate and part retail price. Save the repair order to create recommendations.</p></section>`;
}
export function inspectionResults(ro: RepairOrderView) {
  return `<section class="card"><h2>Inspection photos</h2><p>Save repair order edits before attaching photos or deciding recommendations. These actions refresh the saved repair order.</p><p>JPEG, PNG or WebP; at most 40 KiB per photo.</p>${ro.photos?.length?ro.photos.map(p=>`<p><button type="button" data-photo="${e(p.id)}">View ${e(p.name)}</button> (${p.size} bytes)</p><div id="photo-${e(p.id)}"></div>`).join(''):'<p class="empty">No inspection photos yet.</p>'}<form id="inspection-upload"><input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required><button>Attach photo</button></form></section><section class="card"><h2>Customer recommendations</h2>${ro.recommendations?.length?ro.recommendations.map(r=>`<article><h3>${e(r.description)}</h3><p>${currency(r.estimatedPriceCents)} · ${e(r.status)}</p>${r.decidedAt?`<p>${e(r.decidedBy)} · ${e(r.decidedAt)}</p>`:''}${r.status==='pending'?`<button data-decision="approved" data-rec="${e(r.id)}">Approve and add lines</button> <button data-decision="declined" data-rec="${e(r.id)}">Record decline</button>`:''}</article>`).join(''):'<p class="empty">No recommendations yet.</p>'}</section>`;
}
export function bindInspection(ro: RepairOrderView,ui: UI) {
  const path=`/service/repair-orders/${encodeURIComponent(ro.id)}`;
  document.querySelectorAll<HTMLButtonElement>('[data-decision]').forEach(button=>button.onclick=async()=>{
    button.disabled=true;
    try { await ui.api(path,'PUT',{version:ro.version,recommendationDecision:{id:button.dataset.rec,status:button.dataset.decision}}); if(ui.current())ui.refresh(); } catch(error){ui.flash(error);} finally{button.disabled=false;}
  });
  document.querySelector<HTMLFormElement>('#inspection-upload')!.onsubmit=async event=>{
    event.preventDefault(); const form=event.currentTarget as HTMLFormElement, button=form.querySelector('button')!; button.disabled=true;
    try {
      const file=new FormData(form).get('photo') as File;
      if(file.size>maxDocumentBytes || !file.size) throw new Error('Choose a photo up to 40 KiB.');
      const content=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Unable to read photo.'));reader.readAsDataURL(file);});
      await ui.api(`${path}/photos`,'POST',{version:ro.version,name:file.name,type:file.type,content});if(ui.current())ui.refresh();
    }catch(error){ui.flash(error);}finally{button.disabled=false;}
  };
  document.querySelectorAll<HTMLButtonElement>('[data-photo]').forEach(button=>button.onclick=async()=>{
    try{const photo=ro.photos!.find(p=>p.id===button.dataset.photo)!; const data=await ui.api<{content:string}>(`${path}/photos/${encodeURIComponent(photo.id)}/content`);if(!ui.current())return;const img=document.createElement('img');img.src=`data:${photo.type};base64,${data.content}`;img.alt=photo.name;img.style.maxWidth='100%';document.getElementById(`photo-${photo.id}`)!.replaceChildren(img);}catch(error){ui.flash(error);}
  });
}
