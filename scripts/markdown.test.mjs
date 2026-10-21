import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown, sanitizeUrl } from '../public/markdown.js';

test('raw HTML and attribute-shaped text never become executable markup', () => {
  const html = renderMarkdown('<script>alert("x")</script>\n<img src=x onerror=alert(1)>');
  assert.equal(html, '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.doesNotMatch(html, /<(script|img)\b/i);
});

test('unsafe links and images are rendered without active destinations', () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:msgbox(1)', 'java&#x73;cript:alert(1)']) {
    assert.equal(renderMarkdown(`[safe](${url})`), '<p>safe</p>');
    assert.equal(renderMarkdown(`![safe](${url})`), '<p>safe</p>');
  }
  assert.equal(sanitizeUrl('java\nscript:alert(1)'), null);
  assert.equal(sanitizeUrl('https://example.com/\\evil'), null);
  assert.equal(sanitizeUrl('mailto:hello@example.com', true), null);
});

test('safe links preserve balanced destinations and escaped quoted titles', () => {
  assert.equal(renderMarkdown('[Docs](https://example.com/a_(b) "The \\"guide\\"")'), '<p><a href="https://example.com/a_(b)" title="The &quot;guide&quot;" rel="noopener noreferrer">Docs</a></p>');
  assert.equal(renderMarkdown('[mail](mailto:hello@example.com)'), '<p><a href="mailto:hello@example.com" rel="noopener noreferrer">mail</a></p>');
  assert.equal(renderMarkdown('[relative](/notes#intro)'), '<p><a href="/notes#intro" rel="noopener noreferrer">relative</a></p>');
  assert.equal(renderMarkdown('![a & "b"](https://example.com/image.png)'), '<p><img src="https://example.com/image.png" alt="a &amp; &quot;b&quot;" loading="lazy"></p>');
});

test('headings, explicit paragraphs, multiline text, rules and setext headings', () => {
  assert.equal(renderMarkdown('# One\n\nTwo\nlines\n\n---\n\nSetext\n==='), '<h1>One</h1><p>Two<br>lines</p><hr><h1>Setext</h1>');
  assert.equal(renderMarkdown('## Hash#\n\n### Closed ###'), '<h2>Hash#</h2><h3>Closed</h3>');
  assert.equal(renderMarkdown('# A\r\n\r\nB'), '<h1>A</h1><p>B</p>');
});

test('inline emphasis, nested emphasis, strike, escapes and word underscores', () => {
  assert.equal(renderMarkdown('**bold** *italic* ~~gone~~'), '<p><strong>bold</strong> <em>italic</em> <s>gone</s></p>');
  assert.equal(renderMarkdown('***both*** **bold *inside***'), '<p><strong><em>both</em></strong> <strong>bold <em>inside</em></strong></p>');
  assert.equal(renderMarkdown('word_with_underscores \\*literal\\*'), '<p>word_with_underscores *literal*</p>');
});

test('inline code protects delimiter text and supports backticks inside longer runs', () => {
  assert.equal(renderMarkdown('`<b> **safe**` and `` a`b ``'), '<p><code>&lt;b&gt; **safe**</code> and <code>a`b</code></p>');
  assert.equal(renderMarkdown('**before `**` after**'), '<p><strong>before <code>**</code> after</strong></p>');
});

test('fenced code preserves literal tabs, spaces, markup and shorter fences', () => {
  assert.equal(renderMarkdown('````js\n\tconst x = "<img>";  \n```\n````'), '<pre><code data-language="js">\tconst x = &quot;&lt;img&gt;&quot;;  \n```</code></pre>');
  assert.equal(renderMarkdown('~~~\n<x>\n~~~'), '<pre><code>&lt;x&gt;</code></pre>');
});

test('nested unordered and ordered lists retain hierarchy and ordered starts', () => {
  assert.equal(renderMarkdown('- Parent\n  - Child\n  - Next\n- Sibling'), '<ul><li>Parent<ul><li>Child</li><li>Next</li></ul></li><li>Sibling</li></ul>');
  assert.equal(renderMarkdown('3. Three\n4. Four'), '<ol start="3"><li>Three</li><li>Four</li></ol>');
});

test('tasks carry their checked state with an editable native checkbox', () => {
  const html = renderMarkdown('- [ ] Unfinished\n- [x] Finished');
  assert.match(html, /^<ul class="task-list">/);
  assert.match(html, /<li data-task="true"><input type="checkbox" contenteditable="false" aria-label="Complete task"> Unfinished<\/li>/);
  assert.match(html, /aria-label="Complete task" checked> Finished/);
  assert.doesNotMatch(html, /disabled/);
});

test('quotes recursively render headings and nested quotes', () => {
  assert.equal(renderMarkdown('> # Heading\n>\n> > Nested'), '<blockquote><h1>Heading</h1><blockquote><p>Nested</p></blockquote></blockquote>');
});

test('tables retain alignment and escaped pipes without executing raw HTML', () => {
  assert.equal(renderMarkdown('| Left | Right |\n| :--- | ---: |\n| a\\|b | <img> |'), '<table><thead><tr><th style="text-align:left">Left</th><th style="text-align:right">Right</th></tr></thead><tbody><tr><td style="text-align:left">a|b</td><td style="text-align:right">&lt;img&gt;</td></tr></tbody></table>');
  assert.equal(renderMarkdown('| code |\n| --- |\n| `a|b` |'), '<table><thead><tr><th>code</th></tr></thead><tbody><tr><td><code>a|b</code></td></tr></tbody></table>');
});

test('malformed nested link labels remain bounded and render as text', () => {
  const malformed = '['.repeat(5000) + 'end]';
  assert.equal(renderMarkdown(malformed), `<p>${malformed}</p>`);
});
