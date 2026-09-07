const { tErr, getCurrentLocale } = require('../i18n/translations');
const { createPlaFetch } = require('../i18n/pla-fetch');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const undici = require('undici');

const MAX_CATEGORY_FETCH_CONCURRENCY = 6;

async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

async function writeJsonSafe(filePath, data) {
  const payload = JSON.stringify(data, null, 2);
  try {
    const existing = await fsp.readFile(filePath, 'utf8');
    if (existing === payload) return;
  } catch (_) {
    // ignore read errors (file absent or unreadable), we'll rewrite
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {});
  const tmpPath = `${filePath}.tmp`;
  await fsp.writeFile(tmpPath, payload, 'utf8');
  await fsp.rename(tmpPath, filePath);
}

async function mapWithConcurrency(limit, items, iteratorFn) {
  if (!Array.isArray(items) || !items.length) return [];
  const maxWorkers = Math.max(1, Number(limit) || 1);
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) break;
      results[index] = await iteratorFn(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(maxWorkers, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

const fetch = undici.fetch;

// Normalized preferred language (same rule as pla-fetch.js).
// Stored in the cache to detect a language change and re-fetch.
function currentPlaLang() {
  try {
    const base = String(getCurrentLocale() || 'en').slice(0, 2).toLowerCase();
    return /^[a-z]{2}$/.test(base) ? base : 'en';
  } catch (_) {
    return 'en';
  }
}

// Fetches PLA resources prefixed by the UI language,
// with automatic fallback to en/ on failure.
const fetchPla = createPlaFetch(currentPlaLang, undici.fetch);

function parseCategoryNames(html) {
  const names = [];
  const re = /class="category-link"\s+href="([a-z0-9-]+)\.html"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    if (match[1] && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

function appsFromCategoryJson(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { apps: [], descriptions: {} };
  const apps = [];
  const descriptions = {};
  for (const name of Object.keys(data)) {
    if (typeof name !== 'string' || !name) continue;
    apps.push(name);
    const desc = data[name] && typeof data[name].description === 'string' ? data[name].description : null;
    if (desc) descriptions[name] = desc;
  }
  apps.sort((a, b) => a.localeCompare(b));
  return { apps, descriptions };
}

function registerCategoryHandlers(ipcMain, cacheDir) {
  if (!ipcMain) throw new Error('ipcMain instance is required');
  const categoriesCachePath = path.join(cacheDir, 'categories-cache.json');
  const categoriesMetaPath = path.join(cacheDir, 'categories-cache.meta.json');

  // New format: { lang, categories } — the old format (plain array)
  // is migrated on the fly with lang = null.
  async function readCategoriesCache() {
    const raw = await readJsonSafe(categoriesCachePath, null);
    if (Array.isArray(raw)) return { categories: raw, lang: null };
    if (raw && typeof raw === 'object' && Array.isArray(raw.categories)) {
      return { categories: raw.categories, lang: typeof raw.lang === 'string' ? raw.lang : null };
    }
    return { categories: [], lang: null };
  }

  async function updateCategoriesCache(categories, lang) {
    try {
      await writeJsonSafe(categoriesCachePath, { lang, categories });
    } catch (e) {
      console.error('Error writing categories cache:', e);
    }
  }

  ipcMain.handle('delete-categories-cache', async () => {
    try {
      await Promise.all([
        fsp.rm(categoriesCachePath, { force: true }).catch(() => {}),
        fsp.rm(categoriesMetaPath, { force: true }).catch(() => {})
      ]);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('get-categories-cache', async () => {
    try {
      const { categories, lang } = await readCategoriesCache();
      return { ok: true, categories, lang };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('fetch-all-categories', async () => {
    try {
      const [{ categories: prevCategories }, prevMeta] = await Promise.all([
        readCategoriesCache(),
        readJsonSafe(categoriesMetaPath, {})
      ]);
      const previousByName = new Map((prevCategories || []).map((cat) => [cat.name, Array.isArray(cat.apps) ? cat.apps : []]));
      const previousDescByName = new Map((prevCategories || []).map((cat) => [cat.name, (cat.descriptions && typeof cat.descriptions === 'object') ? cat.descriptions : {}]));
      const idxRes = await fetchPla('index.html', { headers: { 'User-Agent': 'AM-GUI' } });
      const html = await idxRes.text();
      const catNames = parseCategoryNames(html);
      if (!catNames.length) throw new Error(tErr('errNoCategories', 'No categories found'));

      const nextMeta = {};
      const results = await mapWithConcurrency(
        MAX_CATEGORY_FETCH_CONCURRENCY,
        catNames,
        async (catName) => {
          const headers = { 'User-Agent': 'AM-GUI' };
          const previousMeta = prevMeta && prevMeta[catName];
          if (previousMeta?.etag) headers['If-None-Match'] = previousMeta.etag;
          if (previousMeta?.lastModified) headers['If-Modified-Since'] = previousMeta.lastModified;

          let catResponse;
          try {
            catResponse = await fetchPla(`categories/${encodeURIComponent(catName)}.json`, { headers });
          } catch (err) {
            console.warn('[categories] fetch failed for', catName, err?.message || err);
            if (previousMeta) nextMeta[catName] = previousMeta;
            return null;
          }

          if (catResponse.status === 304) {
            if (previousMeta) nextMeta[catName] = previousMeta;
            if (previousByName.has(catName)) {
              return { name: catName, apps: previousByName.get(catName), descriptions: previousDescByName.get(catName) || {} };
            }
            return null;
          }
          if (!catResponse.ok) {
            console.warn('[categories] HTTP', catResponse.status, 'for', catName);
            if (previousMeta) nextMeta[catName] = previousMeta;
            return null;
          }
          const data = await catResponse.json();
          const { apps, descriptions } = appsFromCategoryJson(data);
          const etag = catResponse.headers?.get?.('etag');
          const lastModified = catResponse.headers?.get?.('last-modified');
          if (etag || lastModified) {
            nextMeta[catName] = Object.fromEntries(
              Object.entries({ etag, lastModified }).filter(([, v]) => !!v)
            );
          }
          return { name: catName, apps, descriptions };
        }
      );

      const categories = results.filter(Boolean);
      const finalCategories = categories.length ? categories : prevCategories;
      const finalMeta = Object.keys(nextMeta).length ? nextMeta : prevMeta || {};
      const finalLang = currentPlaLang();
      await Promise.all([
        updateCategoriesCache(finalCategories, finalLang),
        writeJsonSafe(categoriesMetaPath, finalMeta).catch((err) => console.warn('Error writing categories meta:', err))
      ]);
      return { ok: true, categories: finalCategories, lang: finalLang };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('fetch-first-category', async () => {
    try {
      const idxRes = await fetchPla('index.html', { headers: { 'User-Agent': 'AM-GUI' } });
      const html = await idxRes.text();
      const catNames = parseCategoryNames(html);
      if (!catNames.length) throw new Error(tErr('errNoCategories', 'No categories found'));
      const catName = catNames[0];
      const catRes = await fetchPla(`categories/${encodeURIComponent(catName)}.json`, { headers: { 'User-Agent': 'AM-GUI' } });
      const data = await catRes.json();
      const { apps, descriptions } = appsFromCategoryJson(data);
      return { ok: true, category: { name: catName, apps, descriptions } };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

module.exports = { registerCategoryHandlers };
