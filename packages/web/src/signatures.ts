import type { SignatureMethod, SignatureRecord, SignatureStatus } from '@freedms/shared';
import { escapeHtml as e } from './format';
export const signatureStatusLabel = (status?: SignatureStatus) => status === 'signed' ? 'Signed' : status === 'superseded' ? 'Signed version replaced' : 'Awaiting signature';
export function signatureCaptureHtml(idPrefix: string, consentText: string): string {
  const id = e(idPrefix);
  return `<section id="${id}" class="signature-capture"><h3>In-store signature capture</h3><p>Captured in the dealership as an auditable record, not a legal e-signature service.</p><p>${e(consentText)}</p><label>Signer name<input data-signer maxlength="160" required></label><fieldset><legend>Signature method</legend><label><input type="radio" name="${id}-method" value="drawn" checked>Draw</label><label><input type="radio" name="${id}-method" value="typed">Type to sign</label></fieldset><div data-drawing><canvas width="480" height="160" aria-label="Draw your signature" style="border:1px solid;max-width:100%;touch-action:none"></canvas><button type="button" data-clear>Clear</button></div><label data-typing hidden>Typed signature<input data-typed maxlength="160"></label><p role="alert" data-error></p><button type="button" data-capture>Capture signature</button></section>`;
}
export function bindSignatureCapture(idPrefix: string, submit: (value: {signerName:string; method:SignatureMethod; signatureData:string}) => Promise<unknown>) {
  const root = document.getElementById(idPrefix); if (!root) return;
  const canvas = root.querySelector('canvas')!, ctx = canvas.getContext('2d')!;
  let drawn = false, drawing = false;
  const method = () => root.querySelector<HTMLInputElement>('input[type=radio]:checked')!.value as SignatureMethod;
  root.querySelectorAll('input[type=radio]').forEach(r => r.addEventListener('change', () => {
    root.querySelector<HTMLElement>('[data-drawing]')!.hidden = method() !== 'drawn';
    root.querySelector<HTMLElement>('[data-typing]')!.hidden = method() !== 'typed';
  }));
  const point = (event: PointerEvent) => { const r = canvas.getBoundingClientRect(); return {x:(event.clientX-r.left)*canvas.width/r.width,y:(event.clientY-r.top)*canvas.height/r.height}; };
  canvas.onpointerdown = event => { if (event.button !== 0) return; drawing = true; canvas.setPointerCapture(event.pointerId); const p = point(event); ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineTo(p.x+.1,p.y+.1); ctx.stroke(); drawn = true; };
  canvas.onpointermove = event => { if (!drawing) return; const p=point(event); ctx.lineTo(p.x,p.y); ctx.stroke(); };
  canvas.onpointerup = canvas.onpointercancel = canvas.onlostpointercapture = () => { drawing = false; };
  root.querySelector<HTMLButtonElement>('[data-clear]')!.onclick = () => { ctx.clearRect(0,0,canvas.width,canvas.height); drawn=false; };
  const button = root.querySelector<HTMLButtonElement>('[data-capture]')!;
  button.onclick = async () => {
    button.disabled=true; const error = root.querySelector('[data-error]')!; error.textContent='';
    try {
      const signerName = root.querySelector<HTMLInputElement>('[data-signer]')!.value.trim(), m=method();
      if (!signerName) throw new Error('Enter the signer name.');
      if (m === 'drawn' && !drawn) throw new Error('Draw a signature before capturing it.');
      const signatureData = m === 'drawn' ? canvas.toDataURL('image/png') : root.querySelector<HTMLInputElement>('[data-typed]')!.value.trim();
      if (!signatureData) throw new Error('Type a signature before capturing it.');
      await submit({signerName,method:m,signatureData});
    } catch (cause) { error.textContent = cause instanceof Error ? cause.message : 'Unable to capture signature.'; }
    finally { button.disabled=false; }
  };
}
export function signatureHistoryHtml(signatures: SignatureRecord[], currentHash: string): string {
  if (!signatures.length) return '<p>No signatures captured yet.</p>';
  return `<ul class="signature-history">${signatures.map(s => `<li><p>${e(s.signerName)} · ${e(s.signedAt)} · ${e(s.method)} · Version ${e(s.targetVersion)} · ${s.targetHash === currentHash ? 'Current' : 'Superseded'}</p><p>Document hash: <code style="overflow-wrap:anywhere">${e(s.targetHash)}</code></p>${s.method === 'drawn' && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(s.signatureData) ? `<img src="${e(s.signatureData)}" alt="Signature by ${e(s.signerName)}" style="max-width:100%">` : `<p style="font-family:serif;font-style:italic">${e(s.signatureData)}</p>`}<p>${e(s.consentText)}</p></li>`).join('')}</ul>`;
}
