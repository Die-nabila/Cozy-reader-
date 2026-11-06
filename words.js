// words.js - find the English word under a tap, extract its sentence, and highlight saved words.

const LETTER = /[\p{L}\p{M}]/u;
const WORD_RE = /[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*/gu;

const isLetter = (ch) => !!ch && LETTER.test(ch);
const isJoiner = (ch) => ch === "'" || ch === '’' || ch === '-';

/** Normalised key for a word: lowercase, straight apostrophes, possessive 's removed. */
export function norm(word) {
  let w = word.toLowerCase().replace(/’/g, "'");
  w = w.replace(/'s$/, '');
  return w.replace(/^[-']+|[-']+$/g, '');
}

function caretAt(doc, x, y) {
  try {
    if (doc.caretPositionFromPoint) {
      const p = doc.caretPositionFromPoint(x, y);
      if (p && p.offsetNode) return { node: p.offsetNode, offset: p.offset };
    }
    if (doc.caretRangeFromPoint) {
      const r = doc.caretRangeFromPoint(x, y);
      if (r) return { node: r.startContainer, offset: r.startOffset };
    }
  } catch (_) { /* ignore */ }
  return null;
}

function isBlock(el) {
  const win = el.ownerDocument.defaultView;
  const d = win.getComputedStyle(el).display;
  return !(d.startsWith('inline') || d === 'contents');
}

function defaultBlockOf(node) {
  let el = node.nodeType === 1 ? node : node.parentElement;
  while (el && el.parentElement && el !== el.ownerDocument.body && !isBlock(el)) el = el.parentElement;
  return el;
}

/** Flatten the text nodes of `block` into one string with a node map. <br> counts as a line break. */
function flatten(block) {
  const doc = block.ownerDocument;
  const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  const segs = [];
  let text = '';
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeType === 3) {
      const p = n.parentElement;
      if (p && /^(SCRIPT|STYLE)$/.test(p.tagName)) continue;
      segs.push({ node: n, start: text.length });
      text += n.data;
    } else if (n.tagName === 'BR') {
      text += '\n';
    }
  }
  return { text, segs };
}

function locate(segs, idx, preferEnd) {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const len = s.node.data.length;
    if (idx < s.start + len || (preferEnd && idx === s.start + len)) return { node: s.node, offset: Math.max(0, idx - s.start) };
  }
  const last = segs[segs.length - 1];
  return last ? { node: last.node, offset: last.node.data.length } : null;
}

export function sentenceAround(text, start, end) {
  let s = start;
  while (s > 0) {
    const ch = text[s - 1];
    if (ch === '\n') break;
    if (/[.!?…]/.test(ch) && /\s/.test(text[s] || ' ') && s !== start) break;
    s--;
  }
  let e = end;
  while (e < text.length) {
    const ch = text[e];
    if (ch === '\n') break;
    if (/[.!?…]/.test(ch)) {
      e++;
      while (e < text.length && /["'”’)\]]/.test(text[e])) e++;
      break;
    }
    e++;
  }
  let sentence = text.slice(s, e).replace(/\s+/g, ' ').trim();
  if (sentence.length > 320) {
    const rel = Math.max(0, start - s);
    const from = Math.max(0, rel - 150);
    sentence = (from > 0 ? '… ' : '') + sentence.slice(from, from + 300).trim() + ' …';
  }
  return sentence;
}

/**
 * Identify the word at viewport point (x, y) in `doc`.
 * opts.blockOf(node) -> element whose text should be flattened to find the word (default: nearest block element)
 * opts.contextText(block, idx, wordText) -> optional function that returns a custom context sentence.
 * Returns { word, display, range, sentence, sentenceInitial } or null.
 */
export function wordAtPoint(doc, x, y, opts = {}) {
  const caret = caretAt(doc, x, y);
  if (!caret || !caret.node || caret.node.nodeType !== 3) return null;
  const block = (opts.blockOf || defaultBlockOf)(caret.node);
  if (!block) return null;
  const { text, segs } = flatten(block);
  const seg = segs.find((s) => s.node === caret.node);
  if (!seg) return null;
  let i = seg.start + caret.offset;
  if (!isLetter(text[i])) {
    if (i > 0 && isLetter(text[i - 1])) i -= 1; else return null;
  }
  let a = i, b = i + 1;
  for (;;) {
    if (a > 0 && isLetter(text[a - 1])) { a--; continue; }
    if (a > 1 && isJoiner(text[a - 1]) && isLetter(text[a - 2]) && isLetter(text[a])) { a -= 2; continue; }
    break;
  }
  for (;;) {
    if (b < text.length && isLetter(text[b])) { b++; continue; }
    if (b + 1 < text.length && isJoiner(text[b]) && isLetter(text[b + 1]) && isLetter(text[b - 1])) { b += 2; continue; }
    break;
  }
  const display = text.slice(a, b);
  if (display.length < 1 || display.length > 40) return null;
  const startLoc = locate(segs, a, false);
  const endLoc = locate(segs, b, true);
  if (!startLoc || !endLoc) return null;
  const range = doc.createRange();
  try { range.setStart(startLoc.node, startLoc.offset); range.setEnd(endLoc.node, endLoc.offset); } catch (_) { return null; }
  // The tap must actually land on the word (not on blank space next to it).
  const rects = Array.from(range.getClientRects());
  const tol = 6;
  if (!rects.some((r) => x >= r.left - tol && x <= r.right + tol && y >= r.top - tol && y <= r.bottom + tol)) return null;
  let sentence;
  if (opts.contextText) sentence = opts.contextText(block, a, display);
  if (!sentence) sentence = sentenceAround(text, a, b);
  const before = text.slice(0, a).replace(/["'“‘(\[\s]+$/, '');
  const sentenceInitial = before.length === 0 || /[.!?…:]$/.test(before) || /\n$/.test(text.slice(0, a));
  return { word: display, display, range, sentence, sentenceInitial };
}

/** The form to store: keep capitals only for mid-sentence capitalised words (proper nouns). */
export function storedForm(display, sentenceInitial) {
  const clean = display.replace(/’/g, "'");
  if (/^[A-ZÀ-Þ]/.test(clean) && !sentenceInitial && clean.slice(1) === clean.slice(1).toLowerCase()) return clean;
  return clean.toLowerCase();
}

function skipNode(n) {
  const p = n.parentElement;
  if (!p) return true;
  return /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName);
}

/** Wrap occurrences of saved words under `root` in <mark class="vh">. `set` holds norm() keys. */
export function highlightWords(root, set) {
  if (!root || !set || set.size === 0) return;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) {
    if (skipNode(n)) continue;
    if (n.parentElement.closest && n.parentElement.closest('mark.vh')) continue;
    nodes.push(n);
  }
  for (const node of nodes) {
    const text = node.data;
    const hits = [];
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(text))) {
      if (set.has(norm(m[0]))) hits.push([m.index, m.index + m[0].length]);
    }
    if (!hits.length) continue;
    // split from the end so earlier offsets stay valid
    let cur = node;
    for (let k = hits.length - 1; k >= 0; k--) {
      const [s, e] = hits[k];
      const after = cur.splitText(e);
      const mid = cur.splitText(s);
      const mark = doc.createElement('mark');
      mark.className = 'vh';
      mid.parentNode.replaceChild(mark, mid);
      mark.appendChild(mid);
      void after;
    }
  }
}

/** Remove highlight marks for one normalised word (or all when norm is null). */
export function unhighlight(root, normWord) {
  if (!root) return;
  const marks = Array.from(root.querySelectorAll('mark.vh'));
  const parents = new Set();
  for (const m of marks) {
    if (normWord && norm(m.textContent) !== normWord) continue;
    const p = m.parentNode;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
    parents.add(p);
  }
  parents.forEach((p) => p.normalize());
}
