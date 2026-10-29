import { TERMS_DOCUMENT, PRIVACY_DOCUMENT, type TermsAcceptance } from '@freedms/shared';
import { escapeHtml as e } from './format';

/** Deliberately small subset: all source text is escaped; no raw HTML or active links. */
export function legalMarkdown(source: string): string {
  const inline = (text: string) => e(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return source.trim().split(/\n\s*\n/).map(block => {
    const heading = /^(#{1,6}) (.+)$/.exec(block);
    if (heading) return `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`;
    if (block.split('\n').every(line => /^[-*] /.test(line))) return `<ul>${block.split('\n').map(line => `<li>${inline(line.slice(2))}</li>`).join('')}</ul>`;
    return `<p>${inline(block).replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
}
export function legalPageHtml(kind: 'terms' | 'privacy'): string {
  const doc = kind === 'terms' ? TERMS_DOCUMENT : PRIVACY_DOCUMENT;
  return `<main class="legal-document"><a href="#/">freeDMS</a><p><strong>Draft — pending final legal review</strong> · Version ${e(doc.version)}</p>${legalMarkdown(doc.text)}</main>`;
}
export function acceptanceRecordHtml(record: TermsAcceptance | null): string {
  return `<section class="card"><h2>Workspace terms acceptance</h2>${record ? `<p>Accepted by ${e(record.name)} (${e(record.email ?? 'No email recorded')})</p><p>${e(record.acceptedAt)}</p><p>Terms: ${e(record.termsVersion)} · Privacy: ${e(record.privacyVersion)}</p><p>Sharing policy: ${e(record.sharingPolicy)}</p>` : '<p>No acceptance recorded.</p>'}</section>`;
}
