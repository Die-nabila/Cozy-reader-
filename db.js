// db.js - IndexedDB storage for books, files, reading positions, vocabulary and translation cache.
const DB_NAME = 'cozy-reader';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('positions')) db.createObjectStore('positions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('vocab')) {
        const v = db.createObjectStore('vocab', { keyPath: 'key' });
        v.createIndex('bookId', 'bookId');
      }
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'word' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error || new Error('Could not open the local database.')); };
    req.onblocked = () => reject(new Error('Database is blocked by another tab. Close other tabs and reload.'));
  });
  return dbPromise;
}

function run(storeNames, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Database transaction aborted.'));
    Promise.resolve(fn(tx)).then((r) => { result = r; }, (e) => { try { tx.abort(); } catch (_) {} reject(e); });
  }));
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const db = {
  // ---- books ----
  async addBook(book, blob) {
    return run(['books', 'files'], 'readwrite', (tx) => {
      tx.objectStore('books').put(book);
      tx.objectStore('files').put({ id: book.id, blob });
    });
  },
  getBooks() { return run(['books'], 'readonly', (tx) => wrap(tx.objectStore('books').getAll())); },
  getBook(id) { return run(['books'], 'readonly', (tx) => wrap(tx.objectStore('books').get(id))); },
  async getFile(id) {
    const rec = await run(['files'], 'readonly', (tx) => wrap(tx.objectStore('files').get(id)));
    return rec ? rec.blob : null;
  },
  putBook(book) { return run(['books'], 'readwrite', (tx) => { tx.objectStore('books').put(book); }); },
  deleteBook(id) {
    return run(['books', 'files', 'positions'], 'readwrite', (tx) => {
      tx.objectStore('books').delete(id);
      tx.objectStore('files').delete(id);
      tx.objectStore('positions').delete(id);
    });
  },
  // ---- positions ----
  getPositions() { return run(['positions'], 'readonly', (tx) => wrap(tx.objectStore('positions').getAll())); },
  getPosition(id) { return run(['positions'], 'readonly', (tx) => wrap(tx.objectStore('positions').get(id))); },
  setPosition(pos) { return run(['positions'], 'readwrite', (tx) => { tx.objectStore('positions').put(pos); }); },
  // ---- vocabulary ----
  getVocab() { return run(['vocab'], 'readonly', (tx) => wrap(tx.objectStore('vocab').getAll())); },
  getVocabForBook(bookId) {
    return run(['vocab'], 'readonly', (tx) => wrap(tx.objectStore('vocab').index('bookId').getAll(bookId)));
  },
  getVocabEntry(key) { return run(['vocab'], 'readonly', (tx) => wrap(tx.objectStore('vocab').get(key))); },
  putVocab(entry) { return run(['vocab'], 'readwrite', (tx) => { tx.objectStore('vocab').put(entry); }); },
  deleteVocab(key) { return run(['vocab'], 'readwrite', (tx) => { tx.objectStore('vocab').delete(key); }); },
  // ---- translation cache ----
  async getCached(word) {
    const rec = await run(['cache'], 'readonly', (tx) => wrap(tx.objectStore('cache').get(word)));
    return rec ? rec.translation : null;
  },
  setCached(word, translation) {
    return run(['cache'], 'readwrite', (tx) => { tx.objectStore('cache').put({ word, translation, ts: Date.now() }); });
  },
};

export function vocabKey(bookId, norm) { return bookId + '|' + norm; }
