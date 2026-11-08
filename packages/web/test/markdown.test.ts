import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/markdown.js';

test('markdown renders bold, italic, inline code and headings', () => {
  assert.equal(renderMarkdown('**Stock 999** - 1969 Ford'), '<p><strong>Stock 999</strong> - 1969 Ford</p>');
  assert.equal(renderMarkdown('a *short* note'), '<p>a <em>short</em> note</p>');
  assert.equal(renderMarkdown('the `subtotal` field'), '<p>the <code>subtotal</code> field</p>');
  assert.equal(renderMarkdown('`**not bold**`'), '<p><code>**not bold**</code></p>');
  assert.equal(renderMarkdown('## Morning numbers'), '<p><strong>Morning numbers</strong></p>');
});

test('markdown renders ordered and bullet lists in the shape replies arrive', () => {
  const reply = ['Here are the cars:', '',
    '1. **Stock 999** - 1969 Ford Mustang GT',
    '- VIN: 1FA61RUJH59196900',
    '- Status: Available',
    '2. **Stock 123** - 2024 Tesla Model Y',
    '- VIN: V1V1V1V1'].join('\n');
  const html = renderMarkdown(reply);
  assert.match(html, /^<p>Here are the cars:<\/p><ol><li><strong>Stock 999<\/strong> - 1969 Ford Mustang GT<ul><li>VIN: 1FA61RUJH59196900<\/li><li>Status: Available<\/li><\/ul><\/li><li><strong>Stock 123<\/strong> - 2024 Tesla Model Y<ul><li>VIN: V1V1V1V1<\/li><\/ul><\/li><\/ol>$/);
  assert.equal((html.match(/<ol>/g) ?? []).length, 1);
  assert.ok(!html.includes('**'));
});

test('markdown keeps paragraphs, line breaks, and plain text intact', () => {
  assert.equal(renderMarkdown('First para.\n\nSecond para.'), '<p>First para.</p><p>Second para.</p>');
  assert.equal(renderMarkdown('line one\nline two'), '<p>line one<br>line two</p>');
  assert.equal(renderMarkdown('Just a sentence.'), '<p>Just a sentence.</p>');
  assert.equal(renderMarkdown(''), '');
});

test('markdown can never inject markup from model output', () => {
  const html = renderMarkdown('**<script>alert(1)</script>** and <img src=x onerror=alert(2)>');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('<strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong>'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(2)&gt;'));
});
