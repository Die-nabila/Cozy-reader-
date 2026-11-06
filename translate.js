// translate.js - English -> French word translation. Providers are isolated here:
// to change service, edit the `providers` list only. Each provider is async (word) => string.
import { db } from './db.js';

const TIMEOUT_MS = 9000;

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

function decodeEntities(s) {
  const ta = document.createElement('textarea');
  ta.innerHTML = s;
  return ta.value;
}

// Provider 1: Google Translate public web endpoint (unofficial, no key).
async function googleGtx(word) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=fr&dt=t&q=' + encodeURIComponent(word);
  const data = await fetchJson(url);
  const text = (data && data[0] ? data[0].map((p) => p && p[0] ? p[0] : '').join('') : '').trim();
  if (!text) throw new Error('Empty translation');
  return text;
}

// Provider 2: MyMemory public API (fallback).
async function myMemory(word) {
  const url = 'https://api.mymemory.translated.net/get?langpair=en%7Cfr&q=' + encodeURIComponent(word);
  const data = await fetchJson(url);
  let text = data && data.responseData ? String(data.responseData.translatedText || '') : '';
  if (!data || Number(data.responseStatus) !== 200 || !text || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(text)) {
    throw new Error('MyMemory unavailable');
  }
  return decodeEntities(text).trim();
}

const providers = [googleGtx, myMemory];

function tidy(input, output) {
  let out = output.replace(/\s+/g, ' ').trim();
  const inputHasUpper = /[A-ZÀ-Ý]/.test(input);
  if (!inputHasUpper) {
    if (out === out.toUpperCase() && out.length > 1) out = out.toLowerCase();
    else if (/^[A-ZÀ-Ý][a-zà-ÿ]/.test(out)) out = out.charAt(0).toLowerCase() + out.slice(1);
  }
  return out;
}

const inflight = new Map();

/** Returns the French translation of an English word. Throws Error with a user-friendly message on failure. */
export function translateWord(word) {
  const key = word.toLowerCase();
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const cached = await db.getCached(key);
      if (cached) return cached;
    } catch (_) { /* cache is optional */ }
    let lastErr = null;
    for (const provider of providers) {
      try {
        const raw = await provider(word);
        const text = tidy(word, raw);
        if (text) {
          db.setCached(key, text).catch(() => {});
          return text;
        }
      } catch (e) { lastErr = e; }
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new Error('You are offline. New translations need an internet connection.');
    }
    throw new Error('Translation is unavailable right now. Check your connection and try again.');
  })();
  inflight.set(key, p);
  const clear = () => inflight.delete(key);
  p.then(clear, clear);
  return p;
}
