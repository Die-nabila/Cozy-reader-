// epub-reader.js - EPUB parsing (JSZip) and paginated rendering in a sandboxed iframe.
// Requires the global JSZip (lib/jszip.min.js).
import { wordAtPoint, highlightWords, unhighlight } from './words.js';

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
  css: 'text/css', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
};
const FONT_OBFUSCATION = ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'];

export function resolvePath(base, rel) {
  rel = rel.split('#')[0];
  if (!rel) return base;
  const u = new URL(rel, 'http://x/' + base.split('/').map(encodeURIComponent).join('/'));
  return decodeURIComponent(u.pathname.slice(1));
}
const isExternal = (s) => /^[a-z][a-z0-9+.-]*:/i.test(s);

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('This EPUB contains invalid XML.');
  return doc;
}
const all = (root, name) => Array.from(root.getElementsByTagNameNS('*', name));
const first = (root, name) => root.getElementsByTagNameNS('*', name)[0] || null;

async function replaceAsync(str, re, fn) {
  const parts = [];
  let last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(str))) { parts.push(str.slice(last, m.index), fn(m)); last = m.index + m[0].length; }
  parts.push(str.slice(last));
  const done = await Promise.all(parts);
  return done.join('');
}

export class EpubBook {
  static async open(blob) {
    if (typeof JSZip === 'undefined') throw new Error('EPUB support library failed to load.');
    let zip;
    try { zip = await JSZip.loadAsync(blob); } catch (_) { throw new Error('This file is not a valid EPUB (it could not be unzipped).'); }
    const b = new EpubBook(zip);
    await b.parse();
    return b;
  }

  constructor(zip) { this.zip = zip; this._lc = null; }

  file(path) {
    let f = this.zip.file(path);
    if (f) return f;
    if (!this._lc) { this._lc = {}; this.zip.forEach((p) => { this._lc[p.toLowerCase()] = p; }); }
    const real = this._lc[path.toLowerCase()];
    return real ? this.zip.file(real) : null;
  }

  async text(path) {
    const f = this.file(path);
    if (!f) return null;
    return f.async('string');
  }

  async parse() {
    const enc = await this.text('META-INF/encryption.xml');
    if (enc && /EncryptedData/.test(enc)) {
      const algos = Array.from(enc.matchAll(/Algorithm="([^"]+)"/g)).map((m) => m[1]);
      if (algos.some((a) => !FONT_OBFUSCATION.includes(a))) throw new Error('This EPUB is protected by DRM and cannot be opened.');
    }
    const container = await this.text('META-INF/container.xml');
    if (!container) throw new Error('This is not a valid EPUB (missing container.xml).');
    const rootfile = first(parseXml(container), 'rootfile');
    const opfPath = rootfile && rootfile.getAttribute('full-path');
    if (!opfPath) throw new Error('This EPUB has no package file.');
    const opfText = await this.text(opfPath);
    if (!opfText) throw new Error('This EPUB is missing its package file.');
    const opf = parseXml(opfText);
    this.opfPath = opfPath;

    const meta = first(opf, 'metadata');
    const t = meta && first(meta, 'title');
    const a = meta && first(meta, 'creator');
    this.title = (t && t.textContent.trim()) || '';
    this.author = (a && a.textContent.trim()) || '';

    this.manifest = new Map();
    for (const it of all(opf, 'item')) {
      const href = it.getAttribute('href');
      if (!href) continue;
      this.manifest.set(it.getAttribute('id'), {
        id: it.getAttribute('id'),
        path: resolvePath(opfPath, href),
        type: it.getAttribute('media-type') || '',
        props: it.getAttribute('properties') || '',
      });
    }
    this.spine = [];
    for (const ref of all(opf, 'itemref')) {
      const m = this.manifest.get(ref.getAttribute('idref'));
      if (m && /x?html|xml|svg/i.test(m.type)) this.spine.push(m);
    }
    if (!this.spine.length) throw new Error('This EPUB has no readable chapters.');

    // chapter weights for overall progress
    let total = 0;
    this.cum = [];
    for (const s of this.spine) {
      const f = this.file(s.path);
      const size = f && f._data && f._data.uncompressedSize ? f._data.uncompressedSize : 1000;
      this.cum.push(total);
      total += size;
      s.size = size;
    }
    this.totalSize = total || 1;

    // cover
    let cover = null;
    for (const m of this.manifest.values()) if (/cover-image/.test(m.props)) cover = m;
    if (!cover) {
      const metaCover = all(opf, 'meta').find((m) => m.getAttribute('name') === 'cover');
      if (metaCover) cover = this.manifest.get(metaCover.getAttribute('content')) || null;
    }
    if (!cover) cover = Array.from(this.manifest.values()).find((m) => /^image\//.test(m.type) && /cover/i.test(m.id + m.path)) || null;
    this.cover = cover && /^image\//.test(cover.type) ? cover : null;

    await this.parseToc(opf);
  }

  async coverBlob() {
    if (!this.cover) return null;
    const f = this.file(this.cover.path);
    if (!f) return null;
    const buf = await f.async('arraybuffer');
    return new Blob([buf], { type: this.cover.type });
  }

  async parseToc(opf) {
    this.toc = [];
    const navItem = Array.from(this.manifest.values()).find((m) => /(^|\s)nav(\s|$)/.test(m.props));
    try {
      if (navItem) {
        const html = await this.text(navItem.path);
        if (html) {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const navs = Array.from(doc.querySelectorAll('nav'));
          const nav = navs.find((n) => /(^|\s)toc(\s|$)/.test(n.getAttribute('epub:type') || n.getAttribute('type') || '')) || navs[0];
          const walk = (ol, depth) => {
            for (const li of Array.from(ol.children).filter((c) => c.tagName === 'LI')) {
              const a = li.querySelector(':scope > a, :scope > span > a');
              if (a) this._addToc(a.textContent, a.getAttribute('href'), navItem.path, depth);
              const sub = li.querySelector(':scope > ol');
              if (sub) walk(sub, depth + 1);
            }
          };
          const ol = nav && nav.querySelector('ol');
          if (ol) walk(ol, 0);
        }
      }
      if (!this.toc.length) {
        const spineEl = first(opf, 'spine');
        const ncxItem = spineEl && this.manifest.get(spineEl.getAttribute('toc')) ||
          Array.from(this.manifest.values()).find((m) => /dtb\+xml/.test(m.type));
        if (ncxItem) {
          const ncx = parseXml(await this.text(ncxItem.path));
          const walk = (parent, depth) => {
            for (const np of Array.from(parent.children).filter((c) => c.localName === 'navPoint')) {
              const label = first(np, 'text');
              const content = Array.from(np.children).find((c) => c.localName === 'content');
              if (label && content) this._addToc(label.textContent, content.getAttribute('src'), ncxItem.path, depth);
              walk(np, depth + 1);
            }
          };
          const map = first(ncx, 'navMap');
          if (map) walk(map, 0);
        }
      }
    } catch (_) { /* fall through to fallback */ }
    if (!this.toc.length) {
      this.spine.forEach((s, i) => this.toc.push({ label: 'Section ' + (i + 1), index: i, hash: '', depth: 0 }));
    }
  }

  _addToc(label, href, basePath, depth) {
    if (!href || isExternal(href)) return;
    const path = resolvePath(basePath, href);
    const index = this.spine.findIndex((s) => s.path === path);
    if (index < 0) return;
    const hash = href.includes('#') ? decodeURIComponent(href.split('#')[1]) : '';
    this.toc.push({ label: label.replace(/\s+/g, ' ').trim() || 'Untitled', index, hash, depth });
  }

  indexOfPath(path) { return this.spine.findIndex((s) => s.path === path); }

  /** Prepare chapter `index` for display: returns { bodyHtml, bodyClass, css, urls }. */
  async buildChapter(index) {
    const item = this.spine[index];
    const urls = [];
    const cache = new Map();
    const mk = async (path) => {
      if (cache.has(path)) return cache.get(path);
      const f = this.file(path);
      if (!f) { cache.set(path, null); return null; }
      const ext = path.split('.').pop().toLowerCase();
      const mani = Array.from(this.manifest.values()).find((m) => m.path === path);
      const type = MIME[ext] || (mani && mani.type) || 'application/octet-stream';
      const url = URL.createObjectURL(new Blob([await f.async('arraybuffer')], { type }));
      urls.push(url);
      cache.set(path, url);
      return url;
    };
    const rewriteCss = (css, basePath) => replaceAsync(css, /url\(\s*(['"]?)([^)'"]+)\1\s*\)/g, async (m) => {
      const ref = m[2].trim();
      if (!ref || /^(data:|blob:|#)/i.test(ref) || isExternal(ref)) return m[0];
      const u = await mk(resolvePath(basePath, ref));
      return u ? `url("${u}")` : 'none';
    });

    const f = this.file(item.path);
    if (!f) throw new Error('A chapter file is missing from this EPUB.');
    const text = (await f.async('string')).replace(/^﻿/, '');
    let doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length || !doc.documentElement) {
      doc = new DOMParser().parseFromString(text, 'text/html');
    }

    doc.querySelectorAll('script, iframe, object, embed, audio, video').forEach((n) => n.remove());

    const cssTexts = [];
    const jobs = [];
    for (const link of Array.from(doc.querySelectorAll('link'))) {
      const rel = (link.getAttribute('rel') || '').toLowerCase();
      const href = link.getAttribute('href');
      if (rel.includes('stylesheet') && href && !isExternal(href)) {
        const path = resolvePath(item.path, href);
        jobs.push((async () => {
          const css = await this.text(path);
          if (css) cssTexts.push([link, await rewriteCss(css, path)]);
        })());
      }
      link.remove();
    }
    const order = new Map();
    Array.from(doc.querySelectorAll('style')).forEach((st, i) => {
      jobs.push((async () => { cssTexts.push([st, await rewriteCss(st.textContent, item.path)]); })());
      st.remove();
    });
    for (const img of Array.from(doc.querySelectorAll('img, image'))) {
      for (const attr of ['src', 'href', 'xlink:href']) {
        const v = img.getAttribute(attr);
        if (!v || /^(data:|blob:|#)/i.test(v) || isExternal(v)) continue;
        jobs.push((async () => {
          const u = await mk(resolvePath(item.path, v));
          if (u) img.setAttribute(attr, u);
        })());
      }
      img.removeAttribute('srcset');
    }
    await Promise.all(jobs);
    void order;

    let bodyHtml, bodyClass = '';
    if (doc.body) { bodyHtml = doc.body.innerHTML; bodyClass = doc.body.getAttribute('class') || ''; }
    else bodyHtml = new XMLSerializer().serializeToString(doc.documentElement);
    return { bodyHtml, bodyClass, css: cssTexts.map((c) => c[1]).join('\n'), urls };
  }
}

const BASE_CSS = `
html{background:#fffaf2;-webkit-text-size-adjust:none;hyphens:auto;-webkit-hyphens:auto}
body{color:#3b322c;font-family:Georgia,'Iowan Old Style','Palatino Linotype',serif;line-height:1.6;overflow-wrap:break-word}
p{margin:0 0 .8em}
a{color:#a6485f}
img,svg,video{max-width:100%;height:auto;break-inside:avoid}
h1,h2,h3,h4{break-after:avoid;line-height:1.3}
`;

export class EpubView {
  /**
   * h = { onWord(info), onBlank(xFraction), onRelocate(pos), onError(msg), onEnd() }
   */
  constructor(stage, h) {
    this.h = h;
    this.stage = stage;
    this.iframe = document.createElement('iframe');
    this.iframe.className = 'epub-frame';
    this.iframe.setAttribute('sandbox', 'allow-same-origin');
    this.iframe.title = 'Book content';
    stage.appendChild(this.iframe);
    this.fontSize = 19;
    this.hl = new Set();
    this.urls = [];
    this.page = 0;
    this.pages = 1;
    this.spine = 0;
    this.loadToken = 0;
    this.busy = false;
    this.lastSwipe = 0;
    this.doc = null;
  }

  get toc() { return this.book.toc; }
  get chapterCount() { return this.book.spine.length; }

  async open(blob, pos, fontSize) {
    this.book = await EpubBook.open(blob);
    this.fontSize = fontSize || 19;
    let sp = 0;
    if (pos && Number.isInteger(pos.spine)) sp = Math.min(Math.max(pos.spine, 0), this.book.spine.length - 1);
    await this.showChapter(sp, { frac: pos && typeof pos.frac === 'number' ? pos.frac : 0 });
    return { title: this.book.title, author: this.book.author };
  }

  _revoke() { this.urls.forEach((u) => URL.revokeObjectURL(u)); this.urls = []; }

  async showChapter(index, opts = {}) {
    const token = ++this.loadToken;
    this.busy = true;
    try {
      const ch = await this.book.buildChapter(index);
      if (token !== this.loadToken) { ch.urls.forEach((u) => URL.revokeObjectURL(u)); return; }
      this._revoke();
      this.urls = ch.urls;
      this.spine = index;
      const esc = (s) => s.replace(/<\/style/gi, '<\\/style');
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<style>${BASE_CSS}</style><style>${esc(ch.css)}</style><style id="lay"></style></head>` +
        `<body class="${ch.bodyClass.replace(/"/g, '')}">${ch.bodyHtml}</body></html>`;
      await new Promise((resolve) => {
        this.iframe.onload = () => resolve();
        this.iframe.srcdoc = html;
      });
      if (token !== this.loadToken) return;
      this.doc = this.iframe.contentDocument;
      this._bind();
      if (this.hl.size) highlightWords(this.doc.body, this.hl);
      this._layout();
      // images change the layout once loaded; settle then recount
      const imgs = Array.from(this.doc.images || []).filter((i) => !i.complete);
      if (imgs.length) {
        await Promise.race([
          Promise.all(imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))),
          new Promise((r) => setTimeout(r, 1500)),
        ]);
        if (token !== this.loadToken) return;
        this._layout();
      }
      let target = 0;
      if (opts.atEnd) target = this.pages - 1;
      else if (opts.anchor) target = this._anchorPage(opts.anchor);
      else if (typeof opts.frac === 'number') target = Math.round(opts.frac * this.pages);
      else if (typeof opts.page === 'number') target = opts.page;
      this.goPage(target);
    } catch (e) {
      this.h.onError(e.message || 'Could not display this chapter.');
    } finally {
      if (token === this.loadToken) this.busy = false;
    }
  }

  _bind() {
    const doc = this.doc;
    doc.addEventListener('click', (e) => this._click(e));
    let sx = 0, sy = 0, st = 0;
    doc.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
    }, { passive: true });
    doc.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      if (!t || !st) return;
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 55 && Math.abs(dy) < 45 && Date.now() - st < 700) {
        this.lastSwipe = Date.now();
        if (dx < 0) this.next(); else this.prev();
      }
      st = 0;
    }, { passive: true });
  }

  _click(e) {
    if (Date.now() - this.lastSwipe < 400) return;
    const sel = this.doc.getSelection();
    if (sel && !sel.isCollapsed) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (a) { e.preventDefault(); this._link(a.getAttribute('href')); return; }
    const info = wordAtPoint(this.doc, e.clientX, e.clientY);
    if (info) this.h.onWord(info);
    else this.h.onBlank(e.clientX / Math.max(1, this.iframe.clientWidth));
  }

  _link(href) {
    if (!href || isExternal(href)) return;
    const cur = this.book.spine[this.spine].path;
    const path = resolvePath(cur, href);
    const hash = href.includes('#') ? decodeURIComponent(href.split('#')[1]) : '';
    const idx = this.book.indexOfPath(path);
    if (idx < 0) return;
    if (idx === this.spine && hash) this.goPage(this._anchorPage(hash));
    else this.showChapter(idx, { anchor: hash });
  }

  _layout() {
    if (!this.doc) return;
    const W = this.iframe.clientWidth, H = this.iframe.clientHeight;
    if (W < 50 || H < 50) { this.needsLayout = true; return; }
    this.needsLayout = false;
    const pad = Math.round(Math.min(40, Math.max(18, W * 0.06)));
    const vpad = 18;
    const cw = W - 2 * pad, bh = H - 2 * vpad;
    const fs = this.fontSize;
    const css = `
html{margin:0!important;padding:0!important;height:100%!important;overflow:hidden!important}
body{margin:${vpad}px 0 0 ${pad}px!important;padding:0!important;width:${cw}px!important;max-width:none!important;height:${bh}px!important;
 column-width:${cw}px!important;column-count:1!important;column-gap:${2 * pad}px!important;column-fill:auto!important;
 font-size:${fs}px!important;line-height:1.6!important;color:#3b322c!important;background:transparent!important;
 font-family:Georgia,'Iowan Old Style','Palatino Linotype',serif!important;position:static!important;float:none!important;overflow:visible!important}
body *{float:none!important;position:static!important;color:#3b322c!important;background-color:transparent!important;font-family:inherit!important;max-width:100%!important;box-sizing:border-box}
body a, body a *{color:#a6485f!important}
body pre, body code, body pre *, body code *{font-family:ui-monospace,Menlo,Consolas,monospace!important;font-size:.9em!important;white-space:pre-wrap!important}
body p, body li, body div, body span, body td, body th, body blockquote, body section, body em, body i, body b, body strong{font-size:inherit!important;line-height:1.6!important}
body p, body li{text-align:start!important}
body p, body div, body blockquote, body section{margin-left:0!important;margin-right:0!important;width:auto!important}
body blockquote{padding-left:1em!important;border-left:2px solid #e9c9d1}
body img, body svg, body image{max-width:100%!important;max-height:${bh}px!important;width:auto;height:auto!important;object-fit:contain}
body h1, body h2, body h3, body h4, body h5, body h6{line-height:1.3!important}
body table{display:block;overflow:hidden}
mark.vh{background:rgba(232,138,164,.45)!important;color:inherit!important;border-radius:3px;padding:0 1px}
*{-webkit-tap-highlight-color:transparent}
`;
    this.doc.getElementById('lay').textContent = css;
    this._recount();
  }

  _recount() {
    const W = this.iframe.clientWidth;
    const pad = Math.round(Math.min(40, Math.max(18, W * 0.06)));
    const sw = this.doc.documentElement.scrollWidth;
    this.pages = Math.max(1, Math.round((sw + pad) / W));
    if (this.page > this.pages - 1) this.page = this.pages - 1;
  }

  _anchorPage(id) {
    const doc = this.doc;
    const el = doc.getElementById(id) || doc.getElementsByName(id)[0];
    if (!el) return 0;
    const W = this.iframe.clientWidth;
    const left = el.getBoundingClientRect().left + doc.scrollingElement.scrollLeft;
    return Math.max(0, Math.min(this.pages - 1, Math.floor(left / W)));
  }

  goPage(p) {
    if (!this.doc) return;
    if (this.needsLayout) this._layout();
    p = Math.max(0, Math.min(this.pages - 1, p));
    this.page = p;
    this.doc.scrollingElement.scrollLeft = p * this.iframe.clientWidth;
    this._emit();
  }

  _emit() {
    const b = this.book;
    const inner = this.pages > 1 ? this.page / (this.pages - 1) : 0;
    const progress = Math.min(1, (b.cum[this.spine] + inner * b.spine[this.spine].size) / b.totalSize);
    this.h.onRelocate({
      spine: this.spine, page: this.page, pages: this.pages,
      frac: this.page / this.pages, progress, chapters: b.spine.length,
    });
  }

  next() {
    if (this.busy) return;
    if (this.page < this.pages - 1) this.goPage(this.page + 1);
    else if (this.spine < this.book.spine.length - 1) this.showChapter(this.spine + 1, {});
    else this.h.onEnd && this.h.onEnd();
  }
  prev() {
    if (this.busy) return;
    if (this.page > 0) this.goPage(this.page - 1);
    else if (this.spine > 0) this.showChapter(this.spine - 1, { atEnd: true });
  }
  nextChapter() { if (!this.busy && this.spine < this.book.spine.length - 1) this.showChapter(this.spine + 1, {}); }
  prevChapter() {
    if (this.busy) return;
    if (this.page > 0) this.goPage(0);
    else if (this.spine > 0) this.showChapter(this.spine - 1, {});
  }
  goToToc(entry) {
    if (entry.index === this.spine && entry.hash) this.goPage(this._anchorPage(entry.hash));
    else this.showChapter(entry.index, { anchor: entry.hash });
  }
  currentTocLabel() {
    let label = '';
    for (const t of this.book.toc) if (t.index <= this.spine) label = t.label;
    return label;
  }

  setFontSize(px) {
    this.fontSize = px;
    const frac = this.pages ? this.page / this.pages : 0;
    this._layout();
    this.goPage(Math.round(frac * this.pages));
  }

  relayout() {
    if (!this.doc) return;
    const frac = this.pages ? this.page / this.pages : 0;
    this._layout();
    if (!this.needsLayout) this.goPage(Math.round(frac * this.pages));
  }

  setHighlights(set) {
    this.hl = set;
    if (this.doc && this.doc.body) { unhighlight(this.doc.body); highlightWords(this.doc.body, set); }
  }
  addHighlight() { if (this.doc && this.doc.body) highlightWords(this.doc.body, this.hl); }
  removeHighlight(normWord) { if (this.doc && this.doc.body) unhighlight(this.doc.body, normWord); }

  destroy() {
    this.loadToken++;
    this._revoke();
    this.iframe.remove();
    this.doc = null;
  }
}
