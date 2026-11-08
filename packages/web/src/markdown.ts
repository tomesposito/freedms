import { escapeHtml } from './format.js';

/**
 * Render the small markdown subset assistant replies actually use: bold,
 * italic, inline code, headings, ordered and unordered lists, paragraphs.
 * The text is escaped before any rule runs, so model output can never
 * inject markup of its own. User turns are never rendered through this —
 * they stay literal.
 */
export function renderMarkdown(text: string): string {
  const inline = (raw: string): string => {
    const code: string[] = [];
    let out = escapeHtml(raw).replace(/`([^`]+)`/g, (_match, body: string) => {
      code.push(body);
      return `\u0000${code.length - 1}\u0000`;
    });
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    return out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => `<code>${code[Number(index)]}</code>`);
  };
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: {ordered: boolean; items: {text: string; sub: string[]}[]} | null = null;
  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? 'ol' : 'ul';
      const renderItem = (item: {text: string; sub: string[]}) =>
        `<li>${inline(item.text)}${item.sub.length ? `<ul>${item.sub.map(sub => `<li>${inline(sub)}</li>`).join('')}</ul>` : ''}</li>`;
      html.push(`<${tag}>${list.items.map(renderItem).join('')}</${tag}>`);
    }
    list = null;
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) { flushParagraph(); flushList(); continue; }
    const heading = /^#{1,4}\s+(.*)$/.exec(trimmed);
    if (heading) { flushParagraph(); flushList(); html.push(`<p><strong>${inline(heading[1])}</strong></p>`); continue; }
    const ordered = /^\d{1,3}[.)]\s+(.*)$/.exec(trimmed);
    if (ordered) {
      flushParagraph();
      if (!list?.ordered) { flushList(); list = {ordered: true, items: []}; }
      list.items.push({text: ordered[1], sub: []});
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      // Detail bullets directly under a numbered item belong to that item;
      // nesting them keeps the numbering from restarting at the next item.
      if (list?.ordered && list.items.length) { list.items[list.items.length - 1].sub.push(bullet[1]); continue; }
      if (!list || list.ordered) { flushList(); list = {ordered: false, items: []}; }
      list.items.push({text: bullet[1], sub: []});
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  return html.join('');
}
