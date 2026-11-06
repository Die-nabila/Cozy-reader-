# Cozy Reader

A personal English book reader for your phone. Import EPUB and PDF books, tap any English word to see its
French translation, save it to a vocabulary notebook, and see saved words highlighted as you read.

* Everything is stored **on your device** (IndexedDB). No account, no server, no cloud.
* Works offline for reading imported books and browsing your vocabulary. New translations need internet.
* Installable on Android as an app (PWA).

## 1. Create the GitHub repository

1. Sign in at <https://github.com> and click **New repository** (the green button, or `+` → *New repository*).
2. Name it, for example, `cozy-reader`. Choose **Public** (GitHub Pages is free for public repositories). Click **Create repository**.

## 2. Upload the project files

1. On the empty repository page click **uploading an existing file**.
2. Open the unzipped project folder on your computer and select **everything inside it**
   (`index.html`, `app.js`, `style.css`, … **and** the `lib` and `icons` folders). Drag them all into the browser window.
   Make sure the folders `lib/` and `icons/` are uploaded with their contents.
3. Scroll down and click **Commit changes**. Wait until the upload finishes.

`index.html` must be at the top level of the repository (not inside another folder).

## 3. Turn on GitHub Pages

1. In the repository go to **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Choose branch **main** and folder **/ (root)**, then click **Save**.
4. After a minute or two the page shows your address: `https://YOUR-NAME.github.io/cozy-reader/`.

All paths in the app are relative, so it works from that `/cozy-reader/` sub-folder.

## 4. Open and install on Android

1. Open the address above in **Chrome** on your phone.
2. Tap the **⋮** menu → **Install app** (or **Add to Home screen**) → **Install**.
3. Launch **Cozy Reader** from your home screen.
4. Tap **+ Import** and pick EPUB/PDF files from your phone. Books stay on the device.

### Using it

* **Tap a word** to see the French translation, then **Save to vocabulary**.
* Saved words (from the current book) are highlighted. **Tap a highlighted word → Remove from vocabulary** to un-save it.
* EPUB: swipe or tap the left/right edge to turn pages, `☰` for contents, `A−`/`A+` for text size, `«` `»` for chapters.
* PDF: `‹` `›` to change page, type a page number, `−`/`+` to zoom.
* **Words** (reader) shows words saved from the current book. **Vocabulary** (library) shows all words with search and a per-book filter.
* Deleting a book keeps the words you saved from it.

## Notes

* **Translation** (`translate.js`) tries Google's public translate endpoint first and the MyMemory API as fallback; neither needs a key.
  To use another service, edit only the `providers` list in `translate.js`. Translations you have fetched are cached on the device.
* **Scanned PDFs** (images without a text layer) can be read but words cannot be translated; the app tells you. There is no OCR.
* **DRM-protected EPUBs** cannot be opened.
* **EPUB engine**: EPUBs are parsed with JSZip and rendered by the app's own small paginated renderer (`epub-reader.js`),
  not EPUB.js. Book styles are simplified on purpose (colours, fonts, sizes, floats) for comfortable phone reading.
* **Updates**: the service worker fetches app files from the network first, so a new upload shows up the next time you open the app online.
  If you ever need to force old caches out, change `CACHE_VERSION` in `service-worker.js`.
* **Libraries** are included in `lib/` (PDF.js, JSZip), so no CDN is needed and everything works offline.
* Ask the browser not to clear site data: your books and vocabulary live in the browser's storage.
  Clearing site data for the app will delete them.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `style.css` | Layout and design |
| `app.js` | Library, import, reader controls, word popup, vocabulary screen |
| `epub-reader.js` | EPUB parsing and paginated rendering |
| `pdf-reader.js` | PDF.js page rendering and text layer |
| `words.js` | Word detection under a tap, sentence extraction, highlighting |
| `translate.js` | English → French translation providers |
| `db.js` | IndexedDB storage |
| `service-worker.js`, `manifest.json`, `icons/` | Offline support and installability |
| `lib/` | PDF.js and JSZip (with their licenses) |
