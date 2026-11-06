// pdf-reader.js - PDF.js rendering with a selectable text layer (single page at a time).
import { wordAtPoint, highlightWords, unhighlight, sentenceAround } from './words.js';

let pdfjsPromise = null;
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('./lib/pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;
      return m;
    }).catch((e) => { pdfjsPromise = null; throw e; });
  }
  return pdfjsPromise;
}

export async function openPdfDocument(blob) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const task = pdfjs.getDocument({
    data,
    standardFontDataUrl: new URL('./lib/standard_fonts/', import.meta.url).href,
    wasmUrl: new URL('./lib/wasm/', import.meta.url).href,
    isEvalSupported: false,
  });
  try { return await task.promise; } catch (e) {
    if (e && e.name === 'PasswordException') throw new Error('This PDF is password-protected and cannot be opened.');
    throw new Error('This file is not a valid PDF or is damaged.');
  }
}

export function destroyPdf(pdf) {
  try {
    if (pdf.loadingTask && pdf.loadingTask.destroy) return pdf.loadingTask.destroy();
    if (pdf.destroy) return pdf.destroy();
  } catch (_) { /* ignore */ }
}

/** True if any of the first few pages has selectable text. */
export async function pdfHasText(pdf) {
  const n = Math.min(pdf.numPages, 6);
  for (let i = 1; i <= n; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    if (tc.items.some((it) => it.str && it.str.trim())) return true;
  }
  return false;
}

const ZOOMS = [0.75, 1, 1.25, 1.5, 2, 2.5, 3];

export class PdfView {
  /** h = { onWord(info), onBlank(xFraction), onRelocate(pos), onNoText(bool), onError(msg) } */
  constructor(scrollEl, h) {
    this.h = h;
    this.scrollEl = scrollEl;
    this.pdf = null;
    this.pageNum = 1;
    this.zoomIdx = 1;
    this.hl = new Set();
    this.token = 0;
    this.renderTask = null;
    this.lastSwipe = 0;
    this.pageDiv = document.createElement('div');
    this.pageDiv.className = 'pdf-page';
    this.canvas = document.createElement('canvas');
    this.textDiv = document.createElement('div');
    this.textDiv.className = 'textLayer';
    this.pageDiv.append(this.canvas, this.textDiv);
    scrollEl.appendChild(this.pageDiv);
    this._bind();
  }

  get zoom() { return ZOOMS[this.zoomIdx]; }
  get numPages() { return this.pdf ? this.pdf.numPages : 0; }

  async open(blob, pos) {
    this.pdf = await openPdfDocument(blob);
    const z = pos ? ZOOMS.indexOf(pos.zoom) : -1;
    this.zoomIdx = z >= 0 ? z : 1;
    let p = pos && Number.isInteger(pos.page) ? pos.page : 1;
    p = Math.min(Math.max(1, p), this.pdf.numPages);
    let title = '';
    try { const meta = await this.pdf.getMetadata(); title = (meta.info && meta.info.Title) || ''; } catch (_) {}
    await this.goTo(p);
    return { title };
  }

  _bind() {
    const el = this.scrollEl;
    el.addEventListener('click', (e) => {
      if (Date.now() - this.lastSwipe < 400) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      const info = wordAtPoint(document, e.clientX, e.clientY, {
        blockOf: (node) => {
          const span = (node.nodeType === 1 ? node : node.parentElement).closest('.textLayer span');
          return span && !span.classList.contains('markedContent') ? span : null;
        },
        contextText: (block, idx) => this._pageSentence(block, idx),
      });
      if (info) this.h.onWord(info);
      else this.h.onBlank(e.clientX / Math.max(1, el.clientWidth));
    });
    let sx = 0, sy = 0, st = 0;
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { st = 0; return; }
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      if (!t || !st) return;
      const dx = t.clientX - sx, dy = t.clientY - sy;
      const canPanX = el.scrollWidth > el.clientWidth + 4;
      if (!canPanX && Math.abs(dx) > 60 && Math.abs(dy) < 40 && Date.now() - st < 600) {
        this.lastSwipe = Date.now();
        if (dx < 0) this.next(); else this.prev();
      }
      st = 0;
    }, { passive: true });
  }

  _pageSentence(block, idx) {
    const spans = Array.from(this.textDiv.querySelectorAll('span')).filter((s) => !s.classList.contains('markedContent') && s.getAttribute('role') !== 'img');
    let text = '', offset = -1;
    for (const s of spans) {
      if (s === block) offset = text.length + idx;
      text += s.textContent + ' ';
    }
    if (offset < 0) return null;
    return sentenceAround(text, offset, offset + 1);
  }

  async goTo(n) {
    if (!this.pdf) return;
    n = Math.max(1, Math.min(this.pdf.numPages, n));
    this.pageNum = n;
    await this._render();
    this.scrollEl.scrollTop = 0;
    this.scrollEl.scrollLeft = 0;
  }
  next() { if (this.pageNum < this.numPages) return this.goTo(this.pageNum + 1); }
  prev() { if (this.pageNum > 1) return this.goTo(this.pageNum - 1); }
  zoomIn() { if (this.zoomIdx < ZOOMS.length - 1) { this.zoomIdx++; return this._render(true); } }
  zoomOut() { if (this.zoomIdx > 0) { this.zoomIdx--; return this._render(true); } }
  relayout() { return this._render(true); }

  async _render(keepScroll) {
    if (!this.pdf) return;
    const token = ++this.token;
    const cw = this.scrollEl.clientWidth;
    if (cw < 50) return;
    if (this.renderTask) { try { this.renderTask.cancel(); } catch (_) {} this.renderTask = null; }
    const pageNum = this.pageNum;
    try {
      const page = await this.pdf.getPage(pageNum);
      if (token !== this.token) return;
      const base = page.getViewport({ scale: 1 });
      const fit = Math.min(2.2, (cw - 16) / base.width);
      const scale = fit * this.zoom;
      const viewport = page.getViewport({ scale });
      let out = Math.min(window.devicePixelRatio || 1, 2.5);
      const maxPixels = 14e6;
      if (viewport.width * viewport.height * out * out > maxPixels) out = Math.sqrt(maxPixels / (viewport.width * viewport.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * out);
      canvas.height = Math.floor(viewport.height * out);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';
      const ctx = canvas.getContext('2d');
      this.renderTask = page.render({ canvasContext: ctx, viewport, transform: out !== 1 ? [out, 0, 0, out, 0, 0] : null });
      await this.renderTask.promise;
      if (token !== this.token) return;
      this.renderTask = null;

      const textDiv = document.createElement('div');
      textDiv.className = 'textLayer';
      this.pageDiv.style.setProperty('--total-scale-factor', String(scale));
      this.pageDiv.style.width = Math.floor(viewport.width) + 'px';
      this.pageDiv.style.height = Math.floor(viewport.height) + 'px';
      const pdfjs = await loadPdfjs();
      const tl = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport });
      await tl.render();
      if (token !== this.token) return;

      this.pageDiv.replaceChildren(canvas, textDiv);
      this.canvas = canvas;
      this.textDiv = textDiv;
      const hasText = !!textDiv.querySelector('span');
      this.h.onNoText(!hasText);
      if (hasText && this.hl.size) highlightWords(textDiv, this.hl);
      this._emit();
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      if (token === this.token) this.h.onError('Could not display page ' + pageNum + '.');
    }
  }

  _emit() {
    this.h.onRelocate({ page: this.pageNum, pages: this.numPages, zoom: this.zoom, progress: this.pageNum / this.numPages });
  }

  setHighlights(set) { this.hl = set; unhighlight(this.textDiv); highlightWords(this.textDiv, set); }
  addHighlight() { highlightWords(this.textDiv, this.hl); }
  removeHighlight(normWord) { unhighlight(this.textDiv, normWord); }

  destroy() {
    this.token++;
    if (this.renderTask) { try { this.renderTask.cancel(); } catch (_) {} }
    if (this.pdf) destroyPdf(this.pdf);
    this.pageDiv.remove();
    this.pdf = null;
  }
}
