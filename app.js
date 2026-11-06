// app.js - screens, library, reader glue, word popup and vocabulary notebook.
import { db, vocabKey } from './db.js';
import { translateWord } from './translate.js';
import { norm, storedForm } from './words.js';
import { EpubBook, EpubView } from './epub-reader.js';
import { PdfView, openPdfDocument, pdfHasText, destroyPdf } from './pdf-reader.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const state = {
  books: [],
  positions: new Map(),
  cur: null, // { book, type, view, pos, vocabByNorm: Map, vocabSet: Set }
  screen: 'library',
  coverUrls: [],
};

/* ---------------- small helpers ---------------- */
let toastTimer = null;
function toast(msg, opts = {}) {
  const t = $('toast');
  t.replaceChildren(el('span', null, msg));
  t.className = 'toast' + (opts.error ? ' error' : '');
  if (opts.action) {
    const b = el('button', null, opts.action.label);
    b.type = 'button';
    b.onclick = () => { hideToast(); opts.action.run(); };
    t.appendChild(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, opts.ms || (opts.error ? 6000 : 2600));
}
function hideToast() { $('toast').hidden = true; }

function confirmDialog(text, yesLabel = 'Delete') {
  return new Promise((resolve) => {
    $('confirmText').textContent = text;
    $('confirmYes').textContent = yesLabel;
    $('confirm').hidden = false;
    const done = (v) => { $('confirm').hidden = true; $('confirmYes').onclick = $('confirmNo').onclick = null; resolve(v); };
    $('confirmYes').onclick = () => done(true);
    $('confirmNo').onclick = () => done(false);
  });
}

const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

function showScreen(name) {
  state.screen = name;
  for (const id of ['library', 'reader', 'vocab']) $(id).hidden = id !== name;
}

/* ---------------- library ---------------- */
async function loadLibrary() {
  const [books, positions] = await Promise.all([db.getBooks(), db.getPositions()]);
  state.books = books.sort((a, b) => (positions.find((p) => p.id === b.id)?.updatedAt || b.addedAt) - (positions.find((p) => p.id === a.id)?.updatedAt || a.addedAt));
  state.positions = new Map(positions.map((p) => [p.id, p]));
  renderLibrary();
}

function renderLibrary() {
  state.coverUrls.forEach((u) => URL.revokeObjectURL(u));
  state.coverUrls = [];
  const grid = $('bookGrid');
  grid.replaceChildren();
  $('emptyLibrary').hidden = state.books.length > 0;
  for (const book of state.books) {
    const card = el('div', 'card');
    const open = el('button', 'card-open');
    open.type = 'button';
    open.setAttribute('aria-label', 'Open ' + book.title);
    const cover = el('div', 'cover');
    if (book.cover) {
      const url = URL.createObjectURL(book.cover);
      state.coverUrls.push(url);
      const img = el('img');
      img.alt = '';
      img.src = url;
      cover.appendChild(img);
    } else {
      cover.textContent = book.title;
    }
    const info = el('div', 'card-info');
    info.appendChild(el('div', 'card-title', book.title));
    const pos = state.positions.get(book.id);
    const pct = Math.round(((pos && pos.progress) || 0) * 100);
    const meta = el('div', 'card-meta');
    meta.append(el('span', null, book.author || (book.type === 'pdf' ? 'PDF' : 'EPUB')), el('span', null, pct + '%'));
    const bar = el('div', 'bar');
    const fill = el('i');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    info.append(meta, bar);
    open.append(cover, info);
    open.onclick = () => openBook(book.id);
    const del = el('button', 'card-del', '✕');
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete ' + book.title);
    del.onclick = () => deleteBook(book);
    card.append(open, del, el('span', 'badge', book.type.toUpperCase()));
    grid.appendChild(card);
  }
}

async function deleteBook(book) {
  const ok = await confirmDialog(`Delete "${book.title}" from this device? The book file and your reading position will be removed. Words you saved from it stay in your vocabulary.`);
  if (!ok) return;
  try {
    await db.deleteBook(book.id);
    toast('Book deleted');
    await loadLibrary();
  } catch (e) {
    toast('Could not delete the book: ' + (e.message || e), { error: true });
  }
}

/* ---------------- import ---------------- */
async function thumbFromBlob(blob, width = 300) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, width / bmp.width);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  } catch (_) { return null; }
}

async function pdfThumb(pdf, width = 300) {
  const page = await pdf.getPage(1);
  const v1 = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / v1.width });
  const c = document.createElement('canvas');
  c.width = Math.floor(viewport.width);
  c.height = Math.floor(viewport.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
}

const baseName = (n) => n.replace(/\.(epub|pdf)$/i, '').replace(/[_]+/g, ' ').trim();

async function importOne(file) {
  const lower = file.name.toLowerCase();
  let type = null;
  if (lower.endsWith('.epub') || file.type === 'application/epub+zip') type = 'epub';
  else if (lower.endsWith('.pdf') || file.type === 'application/pdf') type = 'pdf';
  if (!type) throw new Error('Only EPUB and PDF files are supported.');
  if (file.size === 0) throw new Error('The file is empty.');
  if (state.books.some((b) => b.fileName === file.name && b.size === file.size)) throw new Error('This book is already in your library.');

  const book = { id: uid(), type, fileName: file.name, size: file.size, addedAt: Date.now(), title: baseName(file.name), author: '', cover: null, noText: false };
  if (type === 'epub') {
    const epub = await EpubBook.open(file);
    if (epub.title) book.title = epub.title;
    book.author = epub.author || '';
    const cb = await epub.coverBlob();
    if (cb) book.cover = await thumbFromBlob(cb);
  } else {
    const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    if (!new TextDecoder('latin1').decode(head).includes('%PDF')) throw new Error('This file is not a valid PDF.');
    const pdf = await openPdfDocument(file);
    try {
      const meta = await pdf.getMetadata().catch(() => null);
      const mt = meta && meta.info && meta.info.Title ? String(meta.info.Title).trim() : '';
      if (mt.length > 2 && !/^(untitled|microsoft word\b.*|.*\.(docx?|indd|tex|pages|odt|rtf)|.*\bpdf\b)$/i.test(mt)) book.title = mt;
      if (meta && meta.info && meta.info.Author) book.author = String(meta.info.Author).trim();
      book.pages = pdf.numPages;
      book.cover = await pdfThumb(pdf).catch(() => null);
      book.noText = !(await pdfHasText(pdf).catch(() => true));
    } finally { destroyPdf(pdf); }
  }
  try {
    await db.addBook(book, file);
  } catch (e) {
    if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) throw new Error('Not enough storage space on this device for this book.');
    throw new Error('Could not save the book: ' + (e.message || e));
  }
  return book;
}

async function importFiles(files) {
  const status = $('importStatus');
  const errors = [];
  let ok = 0;
  for (const file of files) {
    status.className = 'notice';
    status.textContent = `Importing "${file.name}"…`;
    status.hidden = false;
    try {
      const book = await importOne(file);
      ok++;
      await loadLibrary();
      if (book.noText) errors.push(`"${book.title}" has no selectable text (it looks scanned). You can read it, but word translation won't work.`);
    } catch (e) {
      errors.push(`Couldn't import "${file.name}": ${e.message || e}`);
    }
  }
  if (errors.length) {
    status.className = 'notice error';
    status.textContent = errors.join('  ');
  } else {
    status.hidden = true;
    if (ok) toast(ok === 1 ? 'Book added' : ok + ' books added');
  }
}

/* ---------------- reader ---------------- */
const FS_KEY = 'cozy-font-size';
function getFontSize() { try { const v = parseInt(localStorage.getItem(FS_KEY), 10); return v >= 14 && v <= 32 ? v : 19; } catch (_) { return 19; } }
function setFontSizePref(v) { try { localStorage.setItem(FS_KEY, String(v)); } catch (_) {} }

let saveTimer = null;
function schedulePositionSave() { clearTimeout(saveTimer); saveTimer = setTimeout(flushPosition, 350); }
async function flushPosition() {
  clearTimeout(saveTimer);
  const c = state.cur;
  if (!c || !c.pos) return;
  try { await db.setPosition({ id: c.book.id, position: c.pos, progress: c.pos.progress || 0, updatedAt: Date.now() }); } catch (_) {}
}

function onRelocate(pos) {
  const c = state.cur;
  if (!c) return;
  c.pos = pos;
  if (c.type === 'epub') {
    $('posLabel').textContent = `Ch. ${pos.spine + 1}/${pos.chapters} · p. ${pos.page + 1}/${pos.pages}`;
    $('prevPg').disabled = pos.spine === 0 && pos.page === 0;
    $('nextPg').disabled = pos.spine === pos.chapters - 1 && pos.page === pos.pages - 1;
    $('prevCh').disabled = pos.spine === 0 && pos.page === 0;
    $('nextCh').disabled = pos.spine === pos.chapters - 1;
    const label = c.view.currentTocLabel && c.view.currentTocLabel();
    $('readerTitle').textContent = label ? `${c.book.title} — ${label}` : c.book.title;
    document.querySelectorAll('#tocList button').forEach((b) => b.classList.toggle('current', Number(b.dataset.index) === pos.spine));
  } else {
    if (document.activeElement !== $('pageInput')) $('pageInput').value = pos.page;
    $('pageTotal').textContent = '/ ' + pos.pages;
    $('prevPg').disabled = pos.page <= 1;
    $('nextPg').disabled = pos.page >= pos.pages;
    $('zoomLabel').textContent = Math.round(pos.zoom * 100) + '%';
  }
  schedulePositionSave();
}

async function loadBookVocab(bookId) {
  const entries = await db.getVocabForBook(bookId);
  const map = new Map(entries.map((e) => [e.norm, e]));
  return { map, set: new Set(map.keys()) };
}

async function openBook(id) {
  if (state.cur) return;
  const book = state.books.find((b) => b.id === id);
  if (!book) return;
  history.pushState({ s: 'reader', id }, '');
  showScreen('reader');
  $('readerTitle').textContent = book.title;
  $('stageLoading').hidden = false;
  closeSheet();
  const isEpub = book.type === 'epub';
  $('epubTools').hidden = !isEpub;
  $('tocBtn').hidden = !isEpub;
  $('prevCh').hidden = $('nextCh').hidden = !isEpub;
  $('pdfTools').hidden = isEpub;
  $('posLabel').hidden = !isEpub;
  $('pdfPos').hidden = isEpub;
  $('pdfScroll').hidden = !isEpub ? false : true;
  $('pdfNotice').hidden = true;
  try {
    const [blob, posRec, vocab] = await Promise.all([db.getFile(id), db.getPosition(id), loadBookVocab(id)]);
    if (!blob) throw new Error('The book file is missing from storage.');
    const c = { book, type: book.type, view: null, pos: posRec ? posRec.position : null, vocabByNorm: vocab.map, vocabSet: vocab.set };
    state.cur = c;
    const handlers = {
      onWord: (info) => showWordSheet(info),
      onBlank: (x) => { if (!$('sheet').hidden) closeSheet(); else if (x < 0.28) c.view.prev(); else if (x > 0.72) c.view.next(); },
      onRelocate,
      onError: (m) => toast(m, { error: true }),
      onEnd: () => toast('End of book'),
      onNoText: (none) => { $('pdfNotice').hidden = !none; },
    };
    if (isEpub) {
      c.view = new EpubView($('stage'), handlers);
      c.view.hl = c.vocabSet;
      const info = await c.view.open(blob, c.pos, getFontSize());
      if (info.title && book.title !== info.title && !book.title) book.title = info.title;
      buildToc(c.view);
    } else {
      c.view = new PdfView($('pdfScroll'), handlers);
      c.view.hl = c.vocabSet;
      await c.view.open(blob, c.pos);
      $('pageInput').max = c.view.numPages;
    }
  } catch (e) {
    const msg = e.message || String(e);
    await teardownReader();
    toast('Could not open this book: ' + msg, { error: true });
    history.back();
    return;
  }
  $('stageLoading').hidden = true;
}

async function teardownReader() {
  const c = state.cur;
  await flushPosition();
  if (c && c.view) { try { c.view.destroy(); } catch (_) {} }
  state.cur = null;
  closeSheet();
  closeToc();
  $('pdfScroll').replaceChildren();
  $('stageLoading').hidden = true;
}

function buildToc(view) {
  const list = $('tocList');
  list.replaceChildren();
  for (const entry of view.toc) {
    const li = el('li');
    const b = el('button', null, entry.label);
    b.type = 'button';
    b.dataset.index = entry.index;
    b.style.paddingLeft = 16 + entry.depth * 16 + 'px';
    b.onclick = () => { closeToc(); view.goToToc(entry); };
    li.appendChild(b);
    list.appendChild(li);
  }
}
function openToc() { $('tocPanel').hidden = false; $('tocScrim').hidden = false; closeSheet(); }
function closeToc() { $('tocPanel').hidden = true; $('tocScrim').hidden = true; }

/* ---------------- word popup ---------------- */
let sheetToken = 0;
let sheetCtx = null;

function closeSheet() { sheetToken++; sheetCtx = null; $('sheet').hidden = true; }

function renderSheet(s) {
  $('sheetWord').textContent = s.display;
  const body = $('sheetBody');
  const actions = $('sheetActions');
  body.className = 'sheet-body';
  body.replaceChildren();
  actions.replaceChildren();
  if (s.status === 'loading') {
    body.append(el('div', 'spinner'), el('span', null, 'Translating…'));
  } else if (s.status === 'error') {
    body.classList.add('err');
    body.textContent = s.error;
    const retry = el('button', 'btn ghost', 'Try again');
    retry.type = 'button';
    retry.onclick = () => lookup(s);
    actions.appendChild(retry);
  } else {
    body.appendChild(el('span', null, s.translation));
    if (s.saved) body.appendChild(el('span', 'saved-tag', 'Saved'));
    const b = el('button', 'btn ' + (s.saved ? 'danger' : 'primary'), s.saved ? 'Remove from vocabulary' : 'Save to vocabulary');
    b.type = 'button';
    b.onclick = () => (s.saved ? removeWord(s) : saveWord(s));
    actions.appendChild(b);
  }
  $('sheet').hidden = false;
}

async function lookup(s) {
  const token = ++sheetToken;
  s.status = 'loading';
  renderSheet(s);
  try {
    const tr = await translateWord(s.stored);
    if (token !== sheetToken) return;
    s.translation = tr;
    s.status = 'ready';
  } catch (e) {
    if (token !== sheetToken) return;
    s.status = 'error';
    s.error = e.message || 'Translation is unavailable right now.';
  }
  renderSheet(s);
}

function showWordSheet(info) {
  const c = state.cur;
  if (!c) return;
  closeToc();
  const n = norm(info.display);
  const existing = c.vocabByNorm.get(n);
  const s = {
    display: info.display,
    stored: existing ? existing.word : storedForm(info.display, info.sentenceInitial),
    norm: n,
    sentence: info.sentence,
    saved: !!existing,
    translation: existing ? existing.translation : null,
    status: existing ? 'ready' : 'loading',
  };
  sheetCtx = s;
  if (existing) { sheetToken++; renderSheet(s); } else lookup(s);
}

async function saveWord(s) {
  const c = state.cur;
  if (!c || s.status !== 'ready') return;
  const entry = {
    key: vocabKey(c.book.id, s.norm), word: s.stored, norm: s.norm, translation: s.translation,
    context: s.sentence || '', bookId: c.book.id, bookTitle: c.book.title, addedAt: Date.now(),
  };
  try {
    await db.putVocab(entry);
  } catch (e) { toast('Could not save the word: ' + (e.message || e), { error: true }); return; }
  c.vocabByNorm.set(s.norm, entry);
  c.vocabSet.add(s.norm);
  c.view.addHighlight();
  s.saved = true;
  renderSheet(s);
}

async function removeWord(s) {
  const c = state.cur;
  if (!c) return;
  try {
    await db.deleteVocab(vocabKey(c.book.id, s.norm));
  } catch (e) { toast('Could not remove the word: ' + (e.message || e), { error: true }); return; }
  c.vocabByNorm.delete(s.norm);
  c.vocabSet.delete(s.norm);
  c.view.removeHighlight(s.norm);
  closeSheet();
  toast('Removed from vocabulary');
}

/* ---------------- vocabulary screen ---------------- */
let vocabFilterBook = '';

async function openVocab(bookId) {
  vocabFilterBook = bookId || '';
  $('vocabSearch').value = '';
  history.pushState({ s: 'vocab' }, '');
  showScreen('vocab');
  closeSheet();
  await renderVocab();
}

async function renderVocab() {
  let entries;
  try { entries = await db.getVocab(); } catch (e) { toast('Could not read vocabulary: ' + e.message, { error: true }); return; }
  // book filter options
  const books = new Map();
  for (const e of entries) books.set(e.bookId, e.bookTitle);
  const sel = $('vocabBook');
  if (vocabFilterBook && !books.has(vocabFilterBook)) {
    const b = state.books.find((x) => x.id === vocabFilterBook);
    books.set(vocabFilterBook, b ? b.title : 'This book');
  }
  sel.replaceChildren(new Option('All books', ''));
  for (const [id, title] of Array.from(books).sort((a, b) => a[1].localeCompare(b[1]))) sel.appendChild(new Option(title, id));
  sel.value = vocabFilterBook;

  const q = $('vocabSearch').value.trim().toLowerCase();
  let list = entries.filter((e) => !vocabFilterBook || e.bookId === vocabFilterBook);
  if (q) list = list.filter((e) => (e.word + ' ' + e.translation + ' ' + e.context).toLowerCase().includes(q));
  list.sort((a, b) => b.addedAt - a.addedAt);
  $('vocabCount').textContent = list.length + (list.length === 1 ? ' word' : ' words');

  const ul = $('vocabList');
  ul.replaceChildren();
  const empty = $('vocabEmpty');
  empty.hidden = list.length > 0;
  if (!list.length) {
    empty.replaceChildren();
    empty.append(el('p', 'empty-title', entries.length ? 'No matches' : 'No saved words yet'),
      el('p', null, entries.length ? 'Try a different search or book.' : 'While reading, tap a word and choose “Save to vocabulary”.'));
  }
  for (const e of list) ul.appendChild(vocabItem(e));
}

function contextNode(e) {
  const p = el('p', 'vocab-ctx');
  const text = e.context || '(no context saved)';
  const re = new RegExp("(^|[^\\p{L}])(" + e.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "(?:['’]s)?)(?![\\p{L}])", 'iu');
  const m = e.context ? re.exec(text) : null;
  if (m) {
    const start = m.index + m[1].length;
    p.append(text.slice(0, start), el('b', null, m[2]), text.slice(start + m[2].length));
  } else p.textContent = text;
  return p;
}

function vocabItem(e) {
  const li = el('li', 'vocab-item');
  const top = el('div', 'vocab-top');
  top.append(el('span', 'vocab-word', e.word), el('span', 'vocab-tr', e.translation));
  li.appendChild(top);
  li.appendChild(el('div', 'vocab-meta', `${e.bookTitle} · ${fmtDate(e.addedAt)}`));
  const actions = el('div', 'vocab-actions');
  const ctxBtn = el('button', 'link-btn', 'View context');
  ctxBtn.type = 'button';
  let ctx = null;
  ctxBtn.onclick = () => {
    if (ctx) { ctx.remove(); ctx = null; ctxBtn.textContent = 'View context'; return; }
    ctx = contextNode(e);
    li.appendChild(ctx);
    ctxBtn.textContent = 'Hide context';
  };
  const del = el('button', 'link-btn del', 'Delete');
  del.type = 'button';
  del.onclick = async () => {
    try { await db.deleteVocab(e.key); } catch (err) { toast('Could not delete: ' + err.message, { error: true }); return; }
    toast('Word deleted', { action: { label: 'Undo', run: async () => { await db.putVocab(e); await refreshVocabAfterChange(); } } });
    await refreshVocabAfterChange();
  };
  actions.append(ctxBtn, del);
  li.appendChild(actions);
  return li;
}

async function refreshVocabAfterChange() {
  if (state.screen === 'vocab') await renderVocab();
}

/* ---------------- navigation ---------------- */
async function applyHistoryState(s) {
  const name = (s && s.s) || 'library';
  if (name === 'library') {
    if (state.cur) await teardownReader();
    showScreen('library');
    loadLibrary();
  } else if (name === 'reader') {
    if (state.cur) {
      showScreen('reader');
      // vocabulary may have changed while we were away
      const v = await loadBookVocab(state.cur.book.id);
      state.cur.vocabByNorm = v.map;
      state.cur.vocabSet = v.set;
      state.cur.view.setHighlights(v.set);
      requestAnimationFrame(() => state.cur && state.cur.view.relayout());
    } else showScreen('library');
  } else if (name === 'vocab') {
    showScreen('vocab');
    renderVocab();
  }
}

function wire() {
  $('fileInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) await importFiles(files);
  });
  $('openVocab').onclick = () => openVocab('');
  $('vocabBack').onclick = () => history.back();
  $('readerBack').onclick = () => history.back();
  $('bookVocab').onclick = () => state.cur && openVocab(state.cur.book.id);
  $('vocabSearch').addEventListener('input', renderVocab);
  $('vocabBook').addEventListener('change', (e) => { vocabFilterBook = e.target.value; renderVocab(); });

  $('prevPg').onclick = () => state.cur && state.cur.view.prev();
  $('nextPg').onclick = () => state.cur && state.cur.view.next();
  $('prevCh').onclick = () => state.cur && state.cur.view.prevChapter();
  $('nextCh').onclick = () => state.cur && state.cur.view.nextChapter();
  $('tocBtn').onclick = openToc;
  $('tocClose').onclick = closeToc;
  $('tocScrim').onclick = closeToc;
  $('sheetClose').onclick = closeSheet;
  $('fontUp').onclick = () => changeFont(2);
  $('fontDown').onclick = () => changeFont(-2);
  $('zoomIn').onclick = () => state.cur && state.cur.view.zoomIn();
  $('zoomOut').onclick = () => state.cur && state.cur.view.zoomOut();
  $('pageInput').addEventListener('change', (e) => {
    if (!state.cur || state.cur.type !== 'pdf') return;
    const n = parseInt(e.target.value, 10);
    if (n >= 1) state.cur.view.goTo(n); else e.target.value = state.cur.pos ? state.cur.pos.page : 1;
  });
  $('pageInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

  document.addEventListener('keydown', (e) => {
    if (state.screen !== 'reader' || !state.cur || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowRight') state.cur.view.next();
    else if (e.key === 'ArrowLeft') state.cur.view.prev();
    else if (e.key === 'Escape') { closeSheet(); closeToc(); }
  });

  let rz = null;
  window.addEventListener('resize', () => {
    clearTimeout(rz);
    rz = setTimeout(() => { if (state.cur && state.screen === 'reader') state.cur.view.relayout(); }, 200);
  });
  window.addEventListener('popstate', (e) => applyHistoryState(e.state));
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushPosition(); });
  window.addEventListener('pagehide', flushPosition);
}

function changeFont(delta) {
  const c = state.cur;
  if (!c || c.type !== 'epub') return;
  const next = Math.min(32, Math.max(14, c.view.fontSize + delta));
  if (next === c.view.fontSize) return;
  setFontSizePref(next);
  c.view.setFontSize(next);
}

async function init() {
  wire();
  history.replaceState({ s: 'library' }, '');
  showScreen('library');
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (_) {}
  try { await loadLibrary(); } catch (e) {
    const st = $('importStatus');
    st.className = 'notice error';
    st.textContent = 'Could not open local storage: ' + (e.message || e) + ' (Private browsing mode can block it.)';
    st.hidden = false;
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').then((reg) => reg.update().catch(() => {})).catch(() => {});
  }
}

init();
