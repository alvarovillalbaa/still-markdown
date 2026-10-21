// Markdown stays a portable string. These functions only translate at the DOM boundary.
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));

export function sanitizeUrl(value, image = false) {
  const url = String(value || "").trim();
  if (!url || /[\u0000-\u0020\u007f\\]/.test(url)) return null;
  if (/^[^/?]*&[^;]*;/.test(url)) return null;
  const scheme = url.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme && !(image ? ["http", "https"] : ["http", "https", "mailto", "tel"]).includes(scheme)) return null;
  // A colon before any path separator can be a browser-interpreted scheme.
  if (!scheme && /^[^/?#]*:/.test(url)) return null;
  return url;
}

function closingDelimiter(text, delimiter, start) {
  for (let position = start; position < text.length; position++) {
    if (text[position] === "\\") { position++; continue; }
    if (text[position] === "`") {
      const run = text.slice(position).match(/^`+/)[0];
      let close = text.indexOf(run, position + run.length);
      while (close !== -1 && (text[close - 1] === "`" || text[close + run.length] === "`")) close = text.indexOf(run, close + run.length);
      if (close !== -1) { position = close + run.length - 1; continue; }
    }
    if (text.startsWith(delimiter, position) && position > start && !/\s/.test(text[position - 1])) {
      // A final triple marker can close an italic phrase inside a bold phrase.
      if ((delimiter === "**" || delimiter === "__") && text[position + 2] === delimiter[0]) {
        const singles = [...text.slice(start, position).matchAll(delimiter[0] === "*" ? /(?<![\\*])\*(?!\*)/g : /(?<![\\_])_(?!_)/g)].length;
        if (singles % 2) return position + 1;
      }
      return position;
    }
  }
  return -1;
}

function readLink(text, start, image) {
  const labelStart = start + (image ? 2 : 1);
  let depth = 1;
  let end = labelStart;
  for (; end < text.length; end++) {
    if (text[end] === "\\") { end++; continue; }
    if (text[end] === "[" && ++depth > 24) return null;
    if (text[end] === "]" && --depth === 0) break;
  }
  if (depth !== 0 || text[end + 1] !== "(") return null;
  let cursor = end + 2;
  let destination = "";
  if (text[cursor] === "<") {
    const close = text.indexOf(">", cursor + 1);
    if (close === -1) return null;
    destination = text.slice(cursor + 1, close);
    cursor = close + 1;
  } else {
    let parentheses = 0;
    for (; cursor < text.length; cursor++) {
      const character = text[cursor];
      if (character === "\\" && cursor + 1 < text.length) { destination += text[++cursor]; continue; }
      if (character === "(") parentheses++;
      if (character === ")") {
        if (parentheses === 0) break;
        parentheses--;
      }
      if (/\s/.test(character) && parentheses === 0) break;
      destination += character;
    }
  }
  while (/\s/.test(text[cursor] || "") && cursor < text.length) cursor++;
  let title = "";
  if (text[cursor] === '"' || text[cursor] === "'") {
    const quote = text[cursor++];
    while (cursor < text.length && text[cursor] !== quote) {
      if (text[cursor] === "\\" && cursor + 1 < text.length) cursor++;
      title += text[cursor++];
    }
    if (text[cursor++] !== quote) return null;
    while (/\s/.test(text[cursor] || "") && cursor < text.length) cursor++;
  }
  if (text[cursor] !== ")") return null;
  return { label: text.slice(labelStart, end), destination, title, end: cursor + 1 };
}

function inline(text, depth = 0, allowLinks = true) {
  if (depth > 24) return escapeHtml(text);
  let html = "";
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (character === "\\" && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(text[index + 1] || "")) {
      html += escapeHtml(text[index + 1]); index += 2; continue;
    }
    if (character === "`") {
      const delimiter = text.slice(index).match(/^`+/)[0];
      let close = text.indexOf(delimiter, index + delimiter.length);
      while (close !== -1 && (text[close - 1] === "`" || text[close + delimiter.length] === "`")) close = text.indexOf(delimiter, close + delimiter.length);
      if (close !== -1) {
        let content = text.slice(index + delimiter.length, close).replace(/\n/g, " ");
        if (content.startsWith(" ") && content.endsWith(" ") && /\S/.test(content)) content = content.slice(1, -1);
        html += `<code>${escapeHtml(content)}</code>`; index = close + delimiter.length; continue;
      }
    }
    const isImage = character === "!" && text[index + 1] === "[";
    if (isImage || (character === "[" && allowLinks)) {
      const link = readLink(text, index, isImage);
      if (link) {
        const url = sanitizeUrl(link.destination, isImage);
        const title = link.title ? ` title="${escapeHtml(link.title)}"` : "";
        if (isImage) html += url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(link.label.replace(/\\([\[\]\\])/g, "$1"))}"${title} loading="lazy">` : escapeHtml(link.label);
        else html += url ? `<a href="${escapeHtml(url)}"${title} rel="noopener noreferrer">${inline(link.label, depth + 1, false)}</a>` : inline(link.label, depth + 1, false);
        index = link.end; continue;
      }
    }
    if (character === "<" && allowLinks) {
      const autolink = text.slice(index).match(/^<((?:https?:\/\/|mailto:)[^<>\s]+)>/i);
      if (autolink && sanitizeUrl(autolink[1])) {
        html += `<a href="${escapeHtml(autolink[1])}" rel="noopener noreferrer">${escapeHtml(autolink[1].replace(/^mailto:/i, ""))}</a>`;
        index += autolink[0].length; continue;
      }
    }
    let matched = false;
    for (const [delimiter, tag] of [["***", "strong"], ["___", "strong"], ["**", "strong"], ["__", "strong"], ["~~", "s"], ["*", "em"], ["_", "em"]]) {
      if (!text.startsWith(delimiter, index) || /\s/.test(text[index + delimiter.length] || " ")) continue;
      if (delimiter.includes("_") && /[\p{L}\p{N}]/u.test(text[index - 1] || "")) continue;
      const close = closingDelimiter(text, delimiter, index + delimiter.length);
      if (close === -1) continue;
      const content = inline(text.slice(index + delimiter.length, close), depth + 1, allowLinks);
      html += delimiter.length === 3 ? `<strong><em>${content}</em></strong>` : `<${tag}>${content}</${tag}>`;
      index = close + delimiter.length; matched = true; break;
    }
    if (matched) continue;
    html += character === "\n" ? "<br>" : escapeHtml(character);
    index++;
  }
  return html;
}

function listMarker(line) {
  const match = line.match(/^( *)([-+*]|\d+[.)])\s+(.*)$/);
  return match ? { indent: match[1].length, marker: match[2], ordered: /^\d/.test(match[2]), content: match[3], contentIndent: match[1].length + match[2].length + 1 } : null;
}

function tableCells(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells = [];
  let cell = "";
  let codeDelimiter = "";
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\" && index + 1 < text.length) { cell += text[index] + text[++index]; continue; }
    if (text[index] === "`") {
      const run = text.slice(index).match(/^`+/)[0];
      if (!codeDelimiter) codeDelimiter = run;
      else if (codeDelimiter === run) codeDelimiter = "";
      cell += run; index += run.length - 1; continue;
    }
    if (text[index] === "|" && !codeDelimiter) { cells.push(cell.trim()); cell = ""; }
    else cell += text[index];
  }
  cells.push(cell.trim());
  return cells;
}

const isRule = (line) => /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
const isFence = (line) => line.match(/^ {0,3}(`{3,}|~{3,})([^`]*)$/);
const isTableDelimiter = (line) => line?.includes("-") && tableCells(line).every((cell) => /^:?-{3,}:?$/.test(cell));
function startsBlock(lines, index) {
  const line = lines[index];
  return !line.trim() || /^ {0,3}#{1,6}(?:\s|$)/.test(line) || /^ {0,3}>/.test(line) || isRule(line) || isFence(line) || listMarker(line) || (line.includes("|") && isTableDelimiter(lines[index + 1]));
}

function blocks(lines, depth = 0) {
  if (depth > 24) return `<p>${escapeHtml(lines.join("\n"))}</p>`;
  const output = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = isFence(line);
    if (fence) {
      const content = [];
      const marker = fence[1][0];
      const minimum = fence[1].length;
      index++;
      while (index < lines.length && !new RegExp(`^ {0,3}${marker === "`" ? "`" : "~"}{${minimum},}\\s*$`).test(lines[index])) content.push(lines[index++]);
      if (index < lines.length) index++;
      const language = fence[2].trim().split(/\s/)[0].replace(/[^\w+-]/g, "").slice(0, 48);
      output.push(`<pre><code${language ? ` data-language="${language}"` : ""}>${escapeHtml(content.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})(?:\s+(.*)|$)$/);
    if (heading) { output.push(`<h${heading[1].length}>${inline((heading[2] || "").replace(/\s+#+\s*$/, ""))}</h${heading[1].length}>`); index++; continue; }
    if (isRule(line)) { output.push("<hr>"); index++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const quote = [];
      while (index < lines.length) {
        if (/^ {0,3}>/.test(lines[index])) quote.push(lines[index++].replace(/^ {0,3}> ?/, ""));
        else if (!lines[index].trim() && /^ {0,3}>/.test(lines[index + 1] || "")) { quote.push(""); index++; }
        else break;
      }
      output.push(`<blockquote>${blocks(quote, depth + 1)}</blockquote>`); continue;
    }
    const marker = listMarker(line);
    if (marker) {
      const items = [];
      let hasTasks = false;
      while (index < lines.length) {
        const itemMarker = listMarker(lines[index]);
        if (!itemMarker || itemMarker.indent !== marker.indent || itemMarker.ordered !== marker.ordered) break;
        const task = itemMarker.content.match(/^\[([ xX])\](?:\s+|$)/);
        hasTasks ||= Boolean(task);
        const itemLines = [task ? itemMarker.content.slice(task[0].length) : itemMarker.content];
        index++;
        let separated = false;
        while (index < lines.length) {
          const nextMarker = listMarker(lines[index]);
          if (nextMarker && nextMarker.indent <= marker.indent) break;
          if (!lines[index].trim()) {
            let next = index + 1;
            while (next < lines.length && !lines[next].trim()) next++;
            const nextIndent = (lines[next] || "").match(/^ */)[0].length;
            if (next >= lines.length || nextIndent <= marker.indent) break;
            itemLines.push(""); index++; separated = true; continue;
          }
          const indent = lines[index].match(/^ */)[0].length;
          if (indent <= marker.indent && (separated || startsBlock(lines, index))) break;
          itemLines.push(lines[index++].slice(Math.min(indent, itemMarker.contentIndent)));
        }
        let item = blocks(itemLines, depth + 1);
        item = item.replace(/^<p>([\s\S]*?)<\/p>/, "$1");
        items.push(`<li${task ? ' data-task="true"' : ""}>${task ? `<input type="checkbox" contenteditable="false" aria-label="Complete task"${task[1].toLowerCase() === "x" ? " checked" : ""}> ` : ""}${item}</li>`);
        while (index < lines.length && !lines[index].trim()) index++;
      }
      const tag = marker.ordered ? "ol" : "ul";
      const start = marker.ordered && parseInt(marker.marker, 10) !== 1 ? ` start="${parseInt(marker.marker, 10)}"` : "";
      output.push(`<${tag}${start}${hasTasks ? ' class="task-list"' : ""}>${items.join("")}</${tag}>`); continue;
    }
    if (line.includes("|") && isTableDelimiter(lines[index + 1])) {
      const headers = tableCells(line);
      const delimiters = tableCells(lines[index + 1]);
      if (headers.length === delimiters.length) {
        const alignments = delimiters.map((cell) => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : "");
        const row = (cells, tag) => `<tr>${headers.map((_, column) => `<${tag}${alignments[column] ? ` style="text-align:${alignments[column]}"` : ""}>${inline(cells[column] || "")}</${tag}>`).join("")}</tr>`;
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].trim() && lines[index].includes("|")) rows.push(row(tableCells(lines[index++]), "td"));
        output.push(`<table><thead>${row(headers, "th")}</thead><tbody>${rows.join("")}</tbody></table>`); continue;
      }
    }
    if (index + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1]) && line.trim()) {
      const tag = lines[index + 1].trim()[0] === "=" ? "h1" : "h2";
      output.push(`<${tag}>${inline(line.trim())}</${tag}>`); index += 2; continue;
    }
    const paragraph = [line]; index++;
    while (index < lines.length && !startsBlock(lines, index)) paragraph.push(lines[index++]);
    output.push(`<p>${inline(paragraph.join("\n"))}</p>`);
  }
  return output.join("");
}

export function renderMarkdown(markdown) {
  return blocks(String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n"));
}

const blockTags = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "UL", "OL", "LI", "PRE", "HR", "TABLE", "SECTION", "ARTICLE"]);
const plainText = (value) => value.replace(/\u200b/g, "").replace(/\u00a0/g, " ");
const escapeMarkdown = (value) => plainText(value).replace(/[\\`*_~\[\]<>|]/g, "\\$&");
const codeFence = (text, minimum = 1) => "`".repeat(Math.max(minimum, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
const escapeDestination = (value) => value.replace(/[()\\]/g, "\\$&");
const marked = (content, delimiter) => {
  const match = content.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return match[2] ? `${match[1]}${delimiter}${match[2]}${delimiter}${match[3]}` : content;
};

function serializeInline(node) {
  if (node.nodeType === 3) return escapeMarkdown(node.nodeValue || "");
  if (node.nodeType !== 1) return "";
  const children = () => [...node.childNodes].map(serializeInline).join("");
  const content = children();
  switch (node.tagName) {
    case "BR": return "\n";
    case "B": case "STRONG": return marked(content, "**");
    case "I": case "EM": return marked(content, "*");
    case "DEL": case "S": case "STRIKE": return marked(content, "~~");
    case "CODE": {
      const text = plainText(node.textContent || "").replace(/\n/g, " ");
      const fence = codeFence(text);
      const padding = /^`|`$/.test(text) || (text.startsWith(" ") && text.endsWith(" ") && /\S/.test(text)) ? " " : "";
      return text ? `${fence}${padding}${text}${padding}${fence}` : "";
    }
    case "A": {
      const url = sanitizeUrl(node.getAttribute("href"));
      const title = node.getAttribute("title");
      return url ? `[${content}](${escapeDestination(url)}${title ? ` "${title.replace(/["\\]/g, "\\$&")}"` : ""})` : content;
    }
    case "IMG": {
      const url = sanitizeUrl(node.getAttribute("src"), true);
      const alt = (node.getAttribute("alt") || "").replace(/[\[\]\\]/g, "\\$&").replace(/\n/g, " ");
      const title = node.getAttribute("title");
      return url ? `![${alt}](${escapeDestination(url)}${title ? ` "${title.replace(/["\\]/g, "\\$&")}"` : ""})` : escapeMarkdown(alt);
    }
    case "INPUT": case "SCRIPT": case "STYLE": case "IFRAME": case "OBJECT": return "";
    default: return content;
  }
}

function serializeList(node) {
  let counter = parseInt(node.getAttribute("start"), 10) || 1;
  return [...node.children].filter((child) => child.tagName === "LI").map((item) => {
    const marker = node.tagName === "OL" ? `${counter++}. ` : "- ";
    const checkbox = [...item.children].find((child) => child.tagName === "INPUT" && child.type === "checkbox");
    const content = serializeContainer(item).trim();
    const lines = `${checkbox ? `[${checkbox.checked ? "x" : " "}] ` : ""}${content}`.split("\n");
    return marker + lines.map((line, index) => index ? " ".repeat(marker.length) + line : line).join("\n");
  }).join("\n");
}

function serializeTable(node) {
  const rows = [...node.querySelectorAll("tr")].map((row) => [...row.children].filter((cell) => ["TH", "TD"].includes(cell.tagName)));
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const row = (cells) => `| ${Array.from({ length: width }, (_, index) => cells[index] ? serializeInline(cells[index]).replace(/\n/g, " ").replace(/(?<!\\)\|/g, "\\|") : "").join(" | ")} |`;
  const divider = Array.from({ length: width }, (_, index) => {
    const align = rows[0][index]?.style.textAlign;
    return align === "center" ? ":---:" : align === "right" ? "---:" : align === "left" ? ":---" : "---";
  });
  return [row(rows[0]), `| ${divider.join(" | ")} |`, ...rows.slice(1).map(row)].join("\n");
}

function serializeBlock(node) {
  if (/^H[1-6]$/.test(node.tagName)) return `${"#".repeat(Number(node.tagName[1]))} ${serializeInline(node)}`;
  if (node.tagName === "UL" || node.tagName === "OL") return serializeList(node);
  if (node.tagName === "BLOCKQUOTE") return serializeContainer(node).split("\n").map((line) => line ? `> ${line}` : ">").join("\n");
  if (node.tagName === "PRE") {
    const text = plainText(node.textContent || "");
    const fence = codeFence(text, 3);
    const language = (node.querySelector("code")?.getAttribute("data-language") || "").replace(/[^\w+-]/g, "");
    return `${fence}${language}\n${text}\n${fence}`;
  }
  if (node.tagName === "HR") return "---";
  if (node.tagName === "TABLE") return serializeTable(node);
  return serializeContainer(node);
}

function serializeContainer(node) {
  const sections = [];
  let pending = "";
  const flush = () => {
    if (pending) sections.push(pending.replace(/^(\s*)(#{1,6}\s|>\s|[-+]\s|\d+[.)]\s)/gm, "$1\\$2").replace(/^([ ]*)(-+|=+)\s*$/gm, "$1\\$2"));
    pending = "";
  };
  for (const child of node.childNodes) {
    if (child.nodeType === 1 && blockTags.has(child.tagName)) { flush(); sections.push(serializeBlock(child)); }
    else pending += serializeInline(child);
  }
  flush();
  return sections.join("\n\n");
}

export function serializeMarkdown(element) {
  return serializeContainer(element).replace(/^\n+|\n+$/g, "");
}
