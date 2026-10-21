import { renderMarkdown, sanitizeUrl, serializeMarkdown } from "./markdown.js";

const textBlocks = "p,div,h1,h2,h3,h4,h5,h6,li,pre,td,th";
const blockElements = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "UL", "OL", "LI", "PRE", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "HR"]);
const inlineCommands = { bold: ["strong", "b"], italic: ["em", "i"], strike: ["s", "del", "strike"], code: ["code"] };

function unwrapMatches(fragment, tags) {
  for (const node of [...fragment.querySelectorAll(tags.join(","))]) node.replaceWith(...node.childNodes);
  return fragment;
}

function wrapRuns(container, tag, attributes = {}) {
  const result = document.createDocumentFragment();
  let wrapper = null;
  for (const child of [...container.childNodes]) {
    if (child.nodeType === 1 && blockElements.has(child.tagName)) {
      wrapper = null;
      if (!["PRE", "HR"].includes(child.tagName)) child.replaceChildren(wrapRuns(child, tag, attributes));
      result.append(child);
    } else {
      if (!wrapper) {
        wrapper = document.createElement(tag);
        for (const [name, value] of Object.entries(attributes)) wrapper.setAttribute(name, value);
        result.append(wrapper);
      }
      wrapper.append(child);
    }
  }
  if (tag === "code") {
    for (const code of result.querySelectorAll("code")) code.textContent = code.textContent;
  }
  return result;
}

export class MarkdownEditor {
  constructor(element, { onChange = () => {}, onSelection = () => {} } = {}) {
    this.element = element;
    this.onChange = onChange;
    this.onSelection = onSelection;
    this.composing = false;
    this.savedRange = null;
    this.listeners = [];
    element.contentEditable = "true";
    element.setAttribute("role", "textbox");
    element.setAttribute("aria-multiline", "true");
    element.spellcheck = true;
    this._listen(element, "beforeinput", (event) => {
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        event.preventDefault();
        event.inputType === "historyUndo" ? this.undo() : this.redo();
      } else this._rememberSelection();
    });
    this._listen(element, "input", (event) => {
      if (event.target.matches?.('input[type="checkbox"]')) event.target.toggleAttribute("checked", event.target.checked);
      if (!this.composing) this._commit();
    });
    this._listen(element, "change", (event) => {
      if (event.target.matches?.('input[type="checkbox"]')) {
        event.target.toggleAttribute("checked", event.target.checked);
        this._commit();
      }
    });
    this._listen(element, "compositionstart", () => { this._rememberSelection(); this.composing = true; });
    this._listen(element, "compositionend", () => { this.composing = false; this._commit(); });
    this._listen(element, "keydown", (event) => this._keydown(event));
    this._listen(element, "paste", (event) => {
      event.preventDefault();
      this._insertText(event.clipboardData?.getData("text/plain") || "");
    });
    this._listen(element, "drop", (event) => {
      if (event.dataTransfer?.files.length) return;
      event.preventDefault();
      const position = document.caretPositionFromPoint?.(event.clientX, event.clientY);
      const range = position ? document.createRange() : document.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (position) { range.setStart(position.offsetNode, position.offset); range.collapse(true); }
      if (this._validRange(range)) this._select(range);
      this._insertText(event.dataTransfer?.getData("text/plain") || "");
    });
    this._listen(element, "click", (event) => {
      // Links remain editable; opening a page is explicit through a modifier click.
      const link = event.target.closest?.("a");
      if (link && !event.metaKey && !event.ctrlKey) event.preventDefault();
    });
    this._listen(document, "selectionchange", () => this._selectionChanged());
    this.setMarkdown("");
  }

  _listen(target, type, listener) {
    target.addEventListener(type, listener);
    this.listeners.push(() => target.removeEventListener(type, listener));
  }

  setMarkdown(markdown) {
    this.markdown = String(markdown ?? "");
    this.element.innerHTML = renderMarkdown(this.markdown);
    this.savedRange = null;
    this.history = [{ html: this.element.innerHTML, markdown: this.markdown, selection: null }];
    this.historyIndex = 0;
    this._emptyState();
    this.onSelection(null);
  }

  getMarkdown() { return this.markdown; }
  focus() { this.element.focus({ preventScroll: true }); }
  destroy() { for (const remove of this.listeners) remove(); this.listeners = []; this.onSelection(null); }

  _validRange(range) {
    return Boolean(range && (range.startContainer === this.element || this.element.contains(range.startContainer)) && (range.endContainer === this.element || this.element.contains(range.endContainer)));
  }

  _range() {
    const selection = window.getSelection();
    return selection?.rangeCount && this._validRange(selection.getRangeAt(0)) ? selection.getRangeAt(0).cloneRange() : null;
  }

  _select(range) {
    if (!this._validRange(range)) return;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    this.savedRange = range.cloneRange();
  }

  _restoreSelection() {
    const range = this._range() || (this._validRange(this.savedRange) ? this.savedRange.cloneRange() : null);
    this.focus();
    if (range) this._select(range);
    else {
      const end = document.createRange();
      end.selectNodeContents(this.element); end.collapse(false); this._select(end);
    }
    return this._range();
  }

  _selectionChanged() {
    const range = this._range();
    if (range) this.savedRange = range.cloneRange();
    if (!range || range.collapsed || !range.toString().replace(/\u200b/g, "").trim()) { this.onSelection(null); return; }
    this.onSelection({ rect: range.getBoundingClientRect(), text: range.toString() });
  }

  _bookmark() {
    const range = this._range();
    if (!range) return null;
    const point = (node, offset) => {
      const path = [];
      while (node !== this.element) {
        path.unshift([...node.parentNode.childNodes].indexOf(node));
        node = node.parentNode;
      }
      return { path, offset };
    };
    return { start: point(range.startContainer, range.startOffset), end: point(range.endContainer, range.endOffset) };
  }

  _restoreBookmark(bookmark) {
    if (!bookmark) return;
    const point = ({ path, offset }) => {
      let node = this.element;
      for (const index of path) { if (!node.childNodes[index]) return null; node = node.childNodes[index]; }
      const length = node.nodeType === 3 ? node.length : node.childNodes.length;
      return { node, offset: Math.min(offset, length) };
    };
    const start = point(bookmark.start);
    const end = point(bookmark.end);
    if (!start || !end) return;
    const range = document.createRange();
    range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset); this._select(range);
  }

  _rememberSelection() {
    if (this.history?.[this.historyIndex]) this.history[this.historyIndex].selection = this._bookmark();
  }

  _emptyState() {
    this.element.dataset.empty = String(!this.element.textContent.replace(/\u200b/g, "").trim() && !this.element.querySelector("img,hr,table,input"));
  }

  _commit() {
    const html = this.element.innerHTML;
    const current = this.history[this.historyIndex];
    if (current.html === html) { this._selectionChanged(); return; }
    const next = serializeMarkdown(this.element);
    if (current.html !== html || current.markdown !== next) {
      this.history.splice(this.historyIndex + 1);
      this.history.push({ html, markdown: next, selection: this._bookmark() });
      if (this.history.length > 150) this.history.shift();
      this.historyIndex = this.history.length - 1;
    }
    const changed = this.markdown !== next;
    this.markdown = next;
    this._emptyState();
    if (changed) this.onChange(next);
    this._selectionChanged();
  }

  _historyMove(direction) {
    const index = this.historyIndex + direction;
    if (index < 0 || index >= this.history.length) return;
    this._rememberSelection();
    this.historyIndex = index;
    const state = this.history[index];
    this.element.innerHTML = state.html;
    this.markdown = state.markdown;
    this.savedRange = null;
    this.focus();
    this._restoreBookmark(state.selection);
    this._emptyState();
    this.onChange(this.markdown);
    this._selectionChanged();
  }

  undo() { this._historyMove(-1); }
  redo() { this._historyMove(1); }

  _markers(range) {
    const start = document.createComment("selection-start");
    const end = document.createComment("selection-end");
    const finish = range.cloneRange(); finish.collapse(false); finish.insertNode(end);
    const beginning = range.cloneRange(); beginning.collapse(true); beginning.insertNode(start);
    return { start, end };
  }

  _selectMarkers({ start, end }, collapse = false) {
    if (!this.element.contains(start) || !this.element.contains(end)) return;
    const range = document.createRange();
    range.setStartAfter(start); range.setEndBefore(end);
    start.remove(); end.remove();
    if (collapse) range.collapse(false);
    this._select(range);
  }

  _place(range, fragment, collapse = false) {
    range.deleteContents();
    const start = document.createComment("selection-start");
    const end = document.createComment("selection-end");
    const insertion = document.createDocumentFragment();
    insertion.append(start, fragment, end);
    range.insertNode(insertion);
    this._selectMarkers({ start, end }, collapse);
  }

  _ancestor(node, tags) {
    let element = node.nodeType === 1 ? node : node.parentElement;
    while (element && element !== this.element) {
      if (tags.includes(element.tagName.toLowerCase())) return element;
      element = element.parentElement;
    }
    return null;
  }

  _replaceWithin(ancestor, range, transform) {
    const before = document.createRange(); before.selectNodeContents(ancestor); before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange(); after.selectNodeContents(ancestor); after.setStart(range.endContainer, range.endOffset);
    const prefix = ancestor.cloneNode(false); prefix.append(before.cloneContents());
    const suffix = ancestor.cloneNode(false); suffix.append(after.cloneContents());
    const middle = transform(range.cloneContents());
    const start = document.createComment("selection-start");
    const end = document.createComment("selection-end");
    const replacement = document.createDocumentFragment();
    if (prefix.textContent || prefix.querySelector("img,br,input")) replacement.append(prefix);
    replacement.append(start, middle, end);
    if (suffix.textContent || suffix.querySelector("img,br,input")) replacement.append(suffix);
    ancestor.replaceWith(replacement);
    this._selectMarkers({ start, end });
  }

  _toggleInline(range, tags) {
    const start = this._ancestor(range.startContainer, tags);
    const end = this._ancestor(range.endContainer, tags);
    if (start && start === end) {
      this._replaceWithin(start, range, (fragment) => unwrapMatches(fragment, tags));
      return;
    }
    if (range.collapsed) {
      const wrapper = document.createElement(tags[0]);
      const placeholder = document.createTextNode("\u200b"); wrapper.append(placeholder);
      range.insertNode(wrapper);
      range.setStart(placeholder, 1); range.collapse(true); this._select(range);
      return;
    }
    const fragment = range.extractContents();
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    let allMarked = true;
    let hasText = false;
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent.trim()) continue;
      hasText = true;
      if (!walker.currentNode.parentElement?.closest(tags.join(","))) allMarked = false;
    }
    unwrapMatches(fragment, tags);
    this._place(range, allMarked && hasText ? fragment : wrapRuns(fragment, tags[0]));
  }

  _link(range, value) {
    const url = value ? sanitizeUrl(value) : null;
    if (value && !url) return;
    const start = this._ancestor(range.startContainer, ["a"]);
    const end = this._ancestor(range.endContainer, ["a"]);
    if (range.collapsed && start) {
      if (url) start.setAttribute("href", url);
      else start.replaceWith(...start.childNodes);
      return;
    }
    if (range.collapsed) {
      if (!url) return;
      const anchor = document.createElement("a"); anchor.href = url; anchor.rel = "noopener noreferrer"; anchor.textContent = url;
      this._place(range, anchor, true); return;
    }
    const transform = (fragment) => {
      unwrapMatches(fragment, ["a"]);
      return url ? wrapRuns(fragment, "a", { href: url, rel: "noopener noreferrer" }) : fragment;
    };
    if (start && start === end) this._replaceWithin(start, range, transform);
    else this._place(range, transform(range.extractContents()));
  }

  _ensureParagraphs() {
    let paragraph = null;
    for (const child of [...this.element.childNodes]) {
      if (child.nodeType === 8) continue;
      if (child.nodeType === 1 && blockElements.has(child.tagName)) { paragraph = null; continue; }
      if (!paragraph) { paragraph = document.createElement("p"); child.before(paragraph); }
      paragraph.append(child);
    }
    if (!this.element.firstElementChild) {
      const empty = document.createElement("p"); empty.append(...this.element.childNodes); this.element.append(empty);
    }
  }

  _selectedBlocks(range) {
    const closest = (node) => {
      const element = node.nodeType === 1 ? node : node.parentElement;
      const block = element?.closest(textBlocks);
      return block && block !== this.element && this.element.contains(block) ? block : null;
    };
    if (range.collapsed) return [closest(range.startContainer) || this.element.firstElementChild].filter(Boolean);
    const selected = new Set();
    const walker = document.createTreeWalker(this.element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!range.intersectsNode(node)) continue;
      if (node.nodeType === 3) {
        // Range.intersectsNode also includes a text node touched only at its edge.
        if ((node === range.startContainer && range.startOffset === node.length) || (node === range.endContainer && range.endOffset === 0)) continue;
        const block = closest(node); if (block) selected.add(block);
      } else if (node.matches(textBlocks) && !node.textContent && !node.querySelector(textBlocks)) selected.add(node);
    }
    return [...selected];
  }

  _changeTag(node, tag) {
    if (node.tagName.toLowerCase() === tag) return node;
    const replacement = document.createElement(tag);
    replacement.append(...node.childNodes); node.replaceWith(replacement); return replacement;
  }

  _listItemsToParagraph(item) {
    const result = document.createDocumentFragment();
    let paragraph = document.createElement("p");
    for (const child of [...item.childNodes]) {
      if (child.nodeType === 1 && child.tagName === "INPUT") continue;
      if (child.nodeType === 1 && blockElements.has(child.tagName)) {
        if (paragraph.childNodes.length) result.append(paragraph);
        result.append(child); paragraph = document.createElement("p");
      } else paragraph.append(child);
    }
    if (paragraph.childNodes.length || !result.childNodes.length) result.append(paragraph);
    return result;
  }

  _list(blocks, tag) {
    const originalListBlocks = new Set(blocks.filter((block) => block.closest("li")));
    const listItems = new Set(blocks.map((block) => block.closest("li")).filter((item) => item && this.element.contains(item)));
    const parents = [...new Set([...listItems].map((item) => item.parentElement))].sort((a, b) => a.contains(b) ? 1 : b.contains(a) ? -1 : 0);
    for (const list of parents) {
      const turnOff = list.tagName.toLowerCase() === tag;
      const replacement = document.createDocumentFragment();
      let segment = null;
      let segmentTag = null;
      let originalIndex = parseInt(list.getAttribute("start"), 10) || 1;
      for (const item of [...list.children]) {
        const selected = listItems.has(item);
        if (selected && turnOff) {
          replacement.append(this._listItemsToParagraph(item)); segment = null; segmentTag = null;
        } else {
          const desired = selected ? tag : list.tagName.toLowerCase();
          if (!segment || segmentTag !== desired) {
            segment = document.createElement(desired); segmentTag = desired;
            if (desired === "ol" && originalIndex !== 1) segment.setAttribute("start", originalIndex);
            replacement.append(segment);
          }
          segment.append(item);
        }
        originalIndex++;
      }
      list.replaceWith(replacement);
    }
    let list = null;
    let previous = null;
    for (const block of blocks) {
      if (originalListBlocks.has(block) || !this.element.contains(block) || block.closest("li")) continue;
      if (!list || previous?.nextSibling !== block || list.parentNode !== block.parentNode) {
        list = document.createElement(tag); block.before(list);
      }
      const item = document.createElement("li"); item.append(...block.childNodes); list.append(item);
      previous = list; block.remove();
    }
  }

  _blockFormat(range, command) {
    const markers = this._markers(range);
    this._ensureParagraphs();
    const markedRange = document.createRange(); markedRange.setStartAfter(markers.start); markedRange.setEndBefore(markers.end);
    const blocks = this._selectedBlocks(markedRange);
    if (command === "ul" || command === "ol") this._list(blocks, command);
    else if (command === "quote") {
      const quotes = blocks.map((block) => block.closest("blockquote"));
      if (quotes.length && quotes.every((quote) => quote && quote === quotes[0])) quotes[0].replaceWith(...quotes[0].childNodes);
      else {
        let quote = null;
        for (const block of blocks) {
          if (block.closest("blockquote")) continue;
          if (["LI", "TD", "TH"].includes(block.tagName)) {
            const inner = document.createElement("blockquote");
            for (const child of [...block.childNodes]) if (!(child.nodeType === 1 && ["UL", "OL", "INPUT"].includes(child.tagName))) inner.append(child);
            block.append(inner); quote = null; continue;
          }
          if (!quote || quote.nextSibling !== block || quote.parentNode !== block.parentNode) {
            quote = document.createElement("blockquote"); block.before(quote);
          }
          quote.append(block);
        }
      }
    } else {
      const tag = command === "paragraph" ? "p" : command;
      for (const block of blocks) {
        if (["LI", "TD", "TH"].includes(block.tagName)) {
          const heading = document.createElement(tag);
          for (const child of [...block.childNodes]) if (!(child.nodeType === 1 && ["UL", "OL", "INPUT"].includes(child.tagName))) heading.append(child);
          block.prepend(heading);
        } else if (!["PRE", "TABLE", "UL", "OL"].includes(block.tagName)) this._changeTag(block, tag);
      }
    }
    this._selectMarkers(markers);
  }

  format(command, value) {
    if (this.composing) return;
    const range = this._restoreSelection();
    if (!range) return;
    this._rememberSelection();
    if (inlineCommands[command]) this._toggleInline(range, inlineCommands[command]);
    else if (command === "link") this._link(range, value);
    else if (["h1", "h2", "h3", "paragraph", "quote", "ul", "ol"].includes(command)) this._blockFormat(range, command);
    this._commit();
  }

  _insertText(text) {
    if (!text) return;
    const range = this._restoreSelection();
    this._rememberSelection();
    const fragment = document.createDocumentFragment();
    const pre = this._ancestor(range.startContainer, ["pre"]);
    const normalized = text.replace(/\r\n?/g, "\n");
    if (pre) fragment.append(document.createTextNode(normalized));
    else normalized.split("\n").forEach((line, index) => { if (index) fragment.append(document.createElement("br")); fragment.append(document.createTextNode(line)); });
    this._place(range, fragment, true); this._commit();
  }

  _keydown(event) {
    if (this.composing || event.isComposing) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "z") { event.preventDefault(); event.shiftKey ? this.redo() : this.undo(); return; }
      if (key === "y") { event.preventDefault(); this.redo(); return; }
      const command = key === "b" ? "bold" : key === "i" ? "italic" : event.shiftKey && key === "x" ? "strike" : key === "e" ? "code" : null;
      if (command) { event.preventDefault(); this.format(command); return; }
    }
    const range = this._range();
    if (!range) return;
    const task = this._ancestor(range.startContainer, ["li"]);
    if (event.key === "Enter" && !modifier && !event.shiftKey && range.collapsed && task?.dataset.task === "true") {
      event.preventDefault(); this._rememberSelection();
      if (!task.textContent.replace(/\u200b/g, "").trim()) {
        this._blockFormat(range, task.parentElement.tagName.toLowerCase()); this._commit(); return;
      }
      const remaining = document.createRange(); remaining.selectNodeContents(task); remaining.setStart(range.startContainer, range.startOffset);
      const after = remaining.extractContents();
      const item = document.createElement("li"); item.dataset.task = "true";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.contentEditable = "false"; checkbox.setAttribute("aria-label", "Complete task");
      const space = document.createTextNode(" "); item.append(checkbox, space, after); task.after(item);
      const caret = document.createRange(); caret.setStart(space, 1); caret.collapse(true); this._select(caret); this._commit(); return;
    }
    const pre = this._ancestor(range.startContainer, ["pre"]);
    if (pre) {
      if (event.key === "Enter" && modifier) {
        event.preventDefault(); this._rememberSelection();
        const paragraph = document.createElement("p"); paragraph.append(document.createElement("br")); pre.after(paragraph);
        const caret = document.createRange(); caret.selectNodeContents(paragraph); caret.collapse(true); this._select(caret); this._commit();
      } else if ((event.key === "Enter" && !modifier) || (event.key === "Tab" && !event.shiftKey)) {
        event.preventDefault(); this._insertText(event.key === "Enter" ? "\n" : "  ");
      }
      return;
    }
    if (!range.collapsed || modifier || event.altKey || ![" ", "Enter"].includes(event.key)) return;
    const block = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement).closest("p,div,li");
    if (!block || block === this.element || !this.element.contains(block)) return;
    const before = document.createRange(); before.selectNodeContents(block); before.setEnd(range.startContainer, range.startOffset);
    const prefix = before.toString();
    const shortcuts = { "#": "h1", "##": "h2", "###": "h3", ">": "quote", "-": "ul", "*": "ul", "+": "ul", "1.": "ol" };
    if (event.key === " " && /^\[([ xX])\]$/.test(prefix) && block.tagName === "LI") {
      event.preventDefault(); this._rememberSelection(); before.deleteContents();
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.contentEditable = "false"; checkbox.setAttribute("aria-label", "Complete task");
      checkbox.checked = prefix[1].toLowerCase() === "x"; checkbox.toggleAttribute("checked", checkbox.checked);
      const space = document.createTextNode(" "); block.prepend(checkbox, space); block.dataset.task = "true"; block.parentElement.classList.add("task-list");
      const caret = document.createRange(); caret.setStart(space, 1); caret.collapse(true); this._select(caret); this._commit();
    } else if (event.key === " " && shortcuts[prefix] && block.tagName !== "LI") {
      event.preventDefault(); this._rememberSelection(); before.deleteContents(); before.collapse(true); this._select(before); this.format(shortcuts[prefix]);
    } else if (event.key === "Enter" && /^```[\w+-]*$/.test(prefix) && prefix === block.textContent) {
      event.preventDefault(); this._rememberSelection();
      const pre = document.createElement("pre"); const code = document.createElement("code");
      if (prefix.length > 3) code.dataset.language = prefix.slice(3);
      code.append(document.createTextNode("")); pre.append(code); block.replaceWith(pre);
      const caret = document.createRange(); caret.selectNodeContents(code); caret.collapse(true); this._select(caret); this._commit();
    } else if (event.key === "Enter" && /^(-{3,}|\*{3,}|_{3,})$/.test(prefix) && prefix === block.textContent) {
      event.preventDefault(); this._rememberSelection();
      const paragraph = document.createElement("p"); paragraph.append(document.createElement("br")); block.replaceWith(document.createElement("hr"), paragraph);
      const caret = document.createRange(); caret.selectNodeContents(paragraph); caret.collapse(true); this._select(caret); this._commit();
    }
  }
}
