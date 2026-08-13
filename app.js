/* Losinn's Watchlist — track what you've watched, see what it's rated, get told
   what to watch next.

   Two data sources, because neither IMDb nor Rotten Tomatoes runs a public API:
     · TMDB  — search, artwork, seasons, episode lists, and the recommendation
               graph that "For you" is built on.
     · OMDb  — the relay for the IMDb rating (series AND per-episode), the
               Rotten Tomatoes tomatometer and the Metascore.
   Both keys are the user's own and never leave this browser. Everything else —
   library, scores, progress — is localStorage only. */

'use strict';

/* ══ Constants ═══════════════════════════════════════════════════════════ */

const DB_KEY = 'losinn.watchlist.v1';
const CACHE_KEY = 'losinn.watchlist.cache.v1';

const IMG = 'https://image.tmdb.org/t/p/';
const ANIMATION_GENRE = 16;

// Cache lifetimes. Ratings drift slowly; the recommendation graph slower still.
// The point is to keep OMDb's 1,000/day free quota for things we haven't seen.
const TTL = {
  details: 7 * 864e5,
  ratings: 7 * 864e5,
  season: 14 * 864e5,
  recs: 3 * 864e5,
  search: 1 * 864e5,
};

const STATUSES = [
  { id: 'watching',  label: 'Watching'  },
  { id: 'completed', label: 'Completed' },
  { id: 'planned',   label: 'Plan to watch' },
  { id: 'paused',    label: 'On hold'   },
  { id: 'dropped',   label: 'Dropped'   },
];
const STATUS_LABEL = Object.fromEntries(STATUSES.map(s => [s.id, s.label]));

/* ══ State ═══════════════════════════════════════════════════════════════ */

let state = {
  items: {},          // key -> item
  hidden: {},         // key -> true (dismissed recommendations)
  settings: { tmdbKey: '', omdbKey: '' },
};
let cache = {};

const ui = {
  view: 'library',
  section: 'all',     // all | anime | tv | movie | tag:<name>
  status: 'all',
  sort: 'added',
  filter: '',
  recScope: 'all',
  recs: null,         // last computed list
  searchType: 'all',
};

/* ══ Storage ═════════════════════════════════════════════════════════════ */

function load() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = {
        items: parsed.items || {},
        hidden: parsed.hidden || {},
        settings: Object.assign({ tmdbKey: '', omdbKey: '' }, parsed.settings),
      };
    }
  } catch (e) { console.warn('Could not read library', e); }

  try {
    cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  } catch (e) { cache = {}; }
  pruneCache();
}

function save() {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(state));
  } catch (e) {
    toast('Could not save — browser storage is full.');
  }
}

// Cache writes are frequent, so batch them to the end of the tick.
let cacheTimer = null;
function saveCache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
      // Full: drop the oldest half and try once more rather than dying.
      const entries = Object.entries(cache).sort((a, b) => a[1].t - b[1].t);
      cache = Object.fromEntries(entries.slice(Math.floor(entries.length / 2)));
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (_) {}
    }
  }, 400);
}

function pruneCache() {
  const now = Date.now();
  let dropped = 0;
  for (const [k, v] of Object.entries(cache)) {
    if (!v || typeof v.t !== 'number' || now - v.t > 30 * 864e5) { delete cache[k]; dropped++; }
  }
  if (dropped) saveCache();
}

/* ══ API layer ═══════════════════════════════════════════════════════════ */

class ApiError extends Error {}

async function cached(key, ttl, fetcher) {
  const hit = cache[key];
  if (hit && Date.now() - hit.t < ttl) return hit.d;
  const data = await fetcher();
  cache[key] = { t: Date.now(), d: data };
  saveCache();
  return data;
}

async function tmdb(path, params = {}, ttl = TTL.details) {
  const key = state.settings.tmdbKey.trim();
  if (!key) throw new ApiError('Add your TMDB key in Settings to use this.');

  const qs = new URLSearchParams(params).toString();
  return cached('tmdb:' + path + (qs ? '?' + qs : ''), ttl, async () => {
    const url = `https://api.themoviedb.org/3${path}?api_key=${encodeURIComponent(key)}` +
                (qs ? '&' + qs : '');
    const res = await fetch(url);
    if (res.status === 401) throw new ApiError('TMDB rejected that key — check it in Settings.');
    if (res.status === 404) throw new ApiError('TMDB has no record of that.');
    if (!res.ok) throw new ApiError(`TMDB error ${res.status}.`);
    return res.json();
  });
}

// Returns null (rather than throwing) when there's no OMDb key or no match, so
// callers can treat IMDb/RT numbers as a bonus layer instead of a hard dependency.
async function omdb(params, ttl = TTL.ratings) {
  const key = state.settings.omdbKey.trim();
  if (!key) return null;

  const qs = new URLSearchParams(params).toString();
  return cached('omdb:' + qs, ttl, async () => {
    const res = await fetch(`https://www.omdbapi.com/?apikey=${encodeURIComponent(key)}&${qs}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.Response === 'False') return null;
    return data;
  });
}

/* ══ Normalising TMDB payloads ═══════════════════════════════════════════ */

const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

function normalize(raw, forcedType) {
  const mediaType = forcedType || raw.media_type || (raw.title ? 'movie' : 'tv');
  if (mediaType !== 'tv' && mediaType !== 'movie') return null;

  const date = raw.first_air_date || raw.release_date || '';
  const genres = raw.genre_ids || (raw.genres || []).map(g => g.id);
  const countries = raw.origin_country || (raw.production_countries || []).map(c => c.iso_3166_1);

  return {
    key: `${mediaType}:${raw.id}`,
    mediaType,
    tmdbId: raw.id,
    title: raw.name || raw.title || 'Untitled',
    year: date ? date.slice(0, 4) : '',
    poster: raw.poster_path || null,
    backdrop: raw.backdrop_path || null,
    overview: raw.overview || '',
    genres,
    // "Anime" as most people mean it: Japanese animation. TMDB has no anime flag,
    // so animation + Japanese origin/language is the workable proxy.
    isAnime: genres.includes(ANIMATION_GENRE) &&
             (raw.original_language === 'ja' || countries.includes('JP')),
    tmdbScore: num(raw.vote_average),
    tmdbVotes: raw.vote_count || 0,
  };
}

/* ══ Library operations ══════════════════════════════════════════════════ */

function addToLibrary(media, status = 'completed') {
  if (state.items[media.key]) { toast('Already in your library.'); return state.items[media.key]; }
  const item = Object.assign({}, media, {
    status,
    rating: null,
    progress: null,      // { season, episode }
    tags: [],
    note: '',
    ratings: null,       // { imdb, imdbVotes, rt, meta, fetchedAt }
    addedAt: Date.now(),
    updatedAt: Date.now(),
  });
  state.items[media.key] = item;
  delete state.hidden[media.key];
  save();
  renderAll();
  toast(`Added ${media.title}`);
  return item;
}

function updateItem(key, patch) {
  const item = state.items[key];
  if (!item) return;
  Object.assign(item, patch, { updatedAt: Date.now() });
  save();
  renderAll();
}

function removeItem(key) {
  const item = state.items[key];
  if (!item) return;
  delete state.items[key];
  save();
  renderAll();
  toast(`Removed ${item.title}`);
}

function allTags() {
  const counts = new Map();
  for (const it of Object.values(state.items)) {
    for (const t of it.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function matchesSection(item, section) {
  if (section === 'all') return true;
  if (section === 'anime') return item.isAnime;
  if (section === 'tv') return item.mediaType === 'tv' && !item.isAnime;
  if (section === 'movie') return item.mediaType === 'movie' && !item.isAnime;
  if (section.startsWith('tag:')) return (item.tags || []).includes(section.slice(4));
  return true;
}

function visibleItems() {
  const q = ui.filter.trim().toLowerCase();
  let list = Object.values(state.items)
    .filter(it => matchesSection(it, ui.section))
    .filter(it => ui.status === 'all' || it.status === ui.status)
    .filter(it => !q || it.title.toLowerCase().includes(q));

  const sorters = {
    added:    (a, b) => b.addedAt - a.addedAt,
    updated:  (a, b) => b.updatedAt - a.updatedAt,
    title:    (a, b) => a.title.localeCompare(b.title),
    myrating: (a, b) => (b.rating || 0) - (a.rating || 0),
    imdb:     (a, b) => (b.ratings?.imdb ?? b.tmdbScore ?? 0) - (a.ratings?.imdb ?? a.tmdbScore ?? 0),
    year:     (a, b) => (b.year || '').localeCompare(a.year || ''),
  };
  return list.sort(sorters[ui.sort] || sorters.added);
}

/* ══ Rendering: shared bits ══════════════════════════════════════════════ */

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function posterHtml(media, cls = 'poster') {
  if (media.poster) {
    return `<img class="${cls}" loading="lazy" src="${IMG}w342${media.poster}" alt="${esc(media.title)} poster">`;
  }
  return `<div class="${cls} poster-fallback">${esc(media.title)}</div>`;
}

// One card renderer for every grid — library, search results and recommendations
// only differ by which action buttons they hang off the bottom.
function cardHtml(media, opts = {}) {
  const inLib = state.items[media.key];
  const score = inLib?.ratings?.imdb ?? media.tmdbScore;
  const scoreSrc = inLib?.ratings?.imdb ? 'IMDb' : 'TMDB';

  const badges = [];
  if (score) badges.push(`<span class="badge badge-score" title="${scoreSrc}">${score.toFixed(1)}</span>`);
  if (inLib?.rating) badges.push(`<span class="badge badge-mine" title="Your score">${inLib.rating}</span>`);
  if (media.isAnime) badges.push('<span class="badge-anime">ANIME</span>');

  const meta = [
    media.year || '—',
    media.mediaType === 'tv' ? 'Series' : 'Film',
  ];
  if (inLib) meta.push(STATUS_LABEL[inLib.status]);

  const progress = inLib?.progress
    ? `<div class="card-meta" style="margin-top:3px">S${inLib.progress.season}·E${inLib.progress.episode}</div>` : '';

  return `
    <article class="card" data-key="${media.key}">
      ${inLib ? `<div class="status-strip st-${inLib.status}"></div>` : ''}
      <div style="position:relative">${posterHtml(media)}${badges.join('')}</div>
      <div class="card-body">
        <div class="card-title">${esc(media.title)}</div>
        <div class="card-meta">${meta.map(esc).join(' · ')}</div>
        ${progress}
        ${opts.reason ? `<div class="card-reason">${esc(opts.reason)}</div>` : ''}
      </div>
      ${opts.actions ? `<div class="card-actions">${opts.actions}</div>` : ''}
    </article>`;
}

// Cards are rendered as HTML strings, so the media object for non-library cards
// (search hits, recommendations) is parked here for the click handlers.
const transient = new Map();
function stash(media) { transient.set(media.key, media); return media; }
function mediaFor(key) { return state.items[key] || transient.get(key); }

/* ══ Rendering: library ══════════════════════════════════════════════════ */

function renderSections() {
  const items = Object.values(state.items);
  const count = fn => items.filter(fn).length;

  const base = [
    { id: 'all',   label: 'Everything', n: items.length },
    { id: 'anime', label: 'Anime',      n: count(i => i.isAnime) },
    { id: 'tv',    label: 'TV shows',   n: count(i => i.mediaType === 'tv' && !i.isAnime) },
    { id: 'movie', label: 'Films',      n: count(i => i.mediaType === 'movie' && !i.isAnime) },
  ];

  let html = base.map(s => `
    <button class="mode-item ${ui.section === s.id ? 'active' : ''}" data-section="${s.id}">
      <span>${s.label}</span><span class="count">${s.n}</span>
    </button>`).join('');

  const tags = allTags();
  if (tags.length) {
    html += '<div class="mode-group">Your tags</div>';
    html += tags.map(([t, n]) => `
      <button class="mode-item ${ui.section === 'tag:' + t ? 'active' : ''}" data-section="tag:${esc(t)}">
        <span>${esc(t)}</span><span class="count">${n}</span>
      </button>`).join('');
  }
  $('#sectionList').innerHTML = html;
}

function renderStatusSeg() {
  const items = Object.values(state.items).filter(i => matchesSection(i, ui.section));
  const opts = [{ id: 'all', label: 'All' }].concat(
    STATUSES.map(s => ({ id: s.id, label: s.label.replace('Plan to watch', 'Planned') })));
  $('#statusSeg').innerHTML = opts.map(o => {
    const n = o.id === 'all' ? items.length : items.filter(i => i.status === o.id).length;
    return `<button class="seg-btn ${ui.status === o.id ? 'active' : ''}" data-status="${o.id}">${o.label} ${n ? `(${n})` : ''}</button>`;
  }).join('');
}

function renderStats() {
  const items = Object.values(state.items);
  const rated = items.filter(i => i.rating);
  const avg = rated.length ? (rated.reduce((s, i) => s + i.rating, 0) / rated.length).toFixed(1) : '—';
  const stats = [
    { v: items.filter(i => i.status === 'completed').length, l: 'Completed' },
    { v: items.filter(i => i.status === 'watching').length, l: 'Watching' },
    { v: items.filter(i => i.isAnime).length, l: 'Anime' },
    { v: avg, l: 'Avg score' },
  ];
  $('#statGrid').innerHTML = stats.map(s =>
    `<div class="stat"><div class="s-val">${s.v}</div><div class="s-lbl">${s.l}</div></div>`).join('');
}

function renderLibrary() {
  const list = visibleItems();
  const label = { all: 'Everything', anime: 'Anime', tv: 'TV shows', movie: 'Films' }[ui.section]
    || ui.section.replace('tag:', '#');
  $('#libraryTitle').textContent = label + (ui.status !== 'all' ? ` · ${STATUS_LABEL[ui.status]}` : '');

  $('#libraryGrid').innerHTML = list.map(it => cardHtml(it, {
    actions: it.mediaType === 'tv' && it.status === 'watching'
      ? `<button class="btn btn-secondary btn-tiny" data-act="nextep" data-key="${it.key}">+1 ep</button>`
      : '',
  })).join('');

  const empty = Object.keys(state.items).length === 0;
  $('#libraryEmpty').hidden = !empty;
  if (!empty && !list.length) {
    $('#libraryGrid').innerHTML = '<p class="empty">Nothing matches that filter.</p>';
  }
}

/* ══ Rendering: discover / search ════════════════════════════════════════ */

function renderSearchSeg() {
  const opts = [
    { id: 'all', label: 'Everything' },
    { id: 'tv', label: 'Series' },
    { id: 'movie', label: 'Films' },
    { id: 'anime', label: 'Anime only' },
  ];
  $('#searchTypeSeg').innerHTML = opts.map(o =>
    `<button class="seg-btn ${ui.searchType === o.id ? 'active' : ''}" data-searchtype="${o.id}">${o.label}</button>`).join('');
}

async function runSearch() {
  const q = $('#searchInput').value.trim();
  const grid = $('#searchGrid');
  if (!q) { showTrending(); return; }

  grid.innerHTML = '<p class="loading">Searching…</p>';
  try {
    const data = await tmdb('/search/multi', { query: q, include_adult: 'false' }, TTL.search);
    let results = (data.results || []).map(r => normalize(r)).filter(Boolean);

    if (ui.searchType === 'tv' || ui.searchType === 'movie') {
      results = results.filter(r => r.mediaType === ui.searchType);
    } else if (ui.searchType === 'anime') {
      results = results.filter(r => r.isAnime);
    }
    if (!results.length) { grid.innerHTML = '<p class="empty">No matches.</p>'; return; }

    grid.innerHTML = results.map(r => cardHtml(stash(r), {
      actions: state.items[r.key]
        ? '<button class="btn btn-secondary btn-tiny" disabled>In library</button>'
        : `<button class="btn btn-accent btn-tiny" data-act="add" data-key="${r.key}" data-status="completed">Watched</button>
           <button class="btn btn-secondary btn-tiny" data-act="add" data-key="${r.key}" data-status="planned">Plan</button>`,
    })).join('');
  } catch (e) {
    grid.innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

async function showTrending() {
  const grid = $('#searchGrid');
  if (!state.settings.tmdbKey) { grid.innerHTML = ''; return; }
  grid.innerHTML = '<p class="loading">Loading what\'s trending…</p>';
  try {
    const data = await tmdb('/trending/all/week', {}, TTL.search);
    const results = (data.results || []).map(r => normalize(r)).filter(Boolean).slice(0, 18);
    $('#searchNote').textContent = 'Trending this week — or search for anything you\'ve watched.';
    grid.innerHTML = results.map(r => cardHtml(stash(r), {
      actions: state.items[r.key]
        ? '<button class="btn btn-secondary btn-tiny" disabled>In library</button>'
        : `<button class="btn btn-accent btn-tiny" data-act="add" data-key="${r.key}" data-status="completed">Watched</button>
           <button class="btn btn-secondary btn-tiny" data-act="add" data-key="${r.key}" data-status="planned">Plan</button>`,
    })).join('');
  } catch (e) {
    grid.innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

/* ══ Recommendations ═════════════════════════════════════════════════════ */

// How loudly a library entry votes for what comes next. A 10 counts twice as
// much as a 7; unrated-but-finished still counts, just quietly.
function seedWeight(item) {
  if (item.rating) return Math.max(0.15, (item.rating - 4) / 6);
  if (item.status === 'completed') return 0.55;
  if (item.status === 'watching') return 0.45;
  if (item.status === 'paused') return 0.2;
  return 0;
}

function genreAffinity() {
  const w = new Map();
  let total = 0;
  for (const it of Object.values(state.items)) {
    const sw = seedWeight(it);
    if (sw <= 0) continue;
    for (const g of it.genres || []) { w.set(g, (w.get(g) || 0) + sw); total += sw; }
  }
  if (total > 0) for (const [g, v] of w) w.set(g, v / total);
  return w;
}

async function buildRecs() {
  const grid = $('#recGrid');
  const seeds = Object.values(state.items)
    .filter(i => i.status !== 'dropped' && seedWeight(i) > 0.15)
    .sort((a, b) => seedWeight(b) - seedWeight(a))
    .slice(0, 14);   // cap the request fan-out; the top of your library carries it

  if (!seeds.length) {
    grid.innerHTML = '<p class="empty">Rate a few things you\'ve watched and this fills up.</p>';
    return;
  }

  grid.innerHTML = `<p class="loading">Reading ${seeds.length} of your favourites…</p>`;
  const affinity = genreAffinity();
  const scores = new Map();   // key -> { media, score, why: [] }

  for (const seed of seeds) {
    let pool = [];
    try {
      const [recs, similar] = await Promise.all([
        tmdb(`/${seed.mediaType}/${seed.tmdbId}/recommendations`, {}, TTL.recs).catch(() => ({ results: [] })),
        tmdb(`/${seed.mediaType}/${seed.tmdbId}/similar`, {}, TTL.recs).catch(() => ({ results: [] })),
      ]);
      pool = [...(recs.results || []), ...(similar.results || []).slice(0, 10)];
    } catch (e) {
      if (e instanceof ApiError) { grid.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
      continue;
    }

    const w = seedWeight(seed);
    pool.forEach((raw, i) => {
      const media = normalize(raw, raw.media_type ? undefined : seed.mediaType);
      if (!media || state.items[media.key] || state.hidden[media.key]) return;
      if (!media.poster || media.tmdbVotes < 40) return;

      const positional = 1 / (1 + i * 0.08);
      const entry = scores.get(media.key) || { media, score: 0, why: [] };
      entry.score += w * positional;
      entry.why.push({ title: seed.title, w });
      scores.set(media.key, entry);
    });
  }

  for (const entry of scores.values()) {
    const gs = (entry.media.genres || []).map(g => affinity.get(g) || 0);
    const genreBonus = gs.length ? gs.reduce((a, b) => a + b, 0) / gs.length : 0;
    // Quality nudge so a well-liked title edges out a merely adjacent one.
    const quality = ((entry.media.tmdbScore || 6) - 6) * 0.06;
    entry.score += genreBonus * 1.4 + quality;
  }

  ui.recs = [...scores.values()].sort((a, b) => b.score - a.score);
  renderRecs();
}

function renderRecs() {
  const grid = $('#recGrid');
  if (!ui.recs) { grid.innerHTML = '<p class="empty">Hit Rebuild to generate recommendations.</p>'; return; }

  let list = ui.recs.filter(e => !state.items[e.media.key] && !state.hidden[e.media.key]);
  if (ui.recScope === 'anime') list = list.filter(e => e.media.isAnime);
  if (ui.recScope === 'tv') list = list.filter(e => e.media.mediaType === 'tv' && !e.media.isAnime);
  if (ui.recScope === 'movie') list = list.filter(e => e.media.mediaType === 'movie');
  list = list.slice(0, 40);

  if (!list.length) { grid.innerHTML = '<p class="empty">Nothing left in that category — try Rebuild.</p>'; return; }

  grid.innerHTML = list.map(entry => {
    const why = [...entry.why].sort((a, b) => b.w - a.w).slice(0, 2).map(x => x.title);
    return cardHtml(stash(entry.media), {
      reason: 'Because you watched ' + why.join(' & '),
      actions: `<button class="btn btn-accent btn-tiny" data-act="add" data-key="${entry.media.key}" data-status="planned">Plan</button>
                <button class="btn btn-secondary btn-tiny" data-act="hide" data-key="${entry.media.key}">Not for me</button>`,
    });
  }).join('');
}

function renderRecSeg() {
  const opts = [
    { id: 'all', label: 'Everything' },
    { id: 'anime', label: 'Anime' },
    { id: 'tv', label: 'Series' },
    { id: 'movie', label: 'Films' },
  ];
  $('#recSeg').innerHTML = opts.map(o =>
    `<button class="seg-btn ${ui.recScope === o.id ? 'active' : ''}" data-recscope="${o.id}">${o.label}</button>`).join('');
}

/* ══ Ratings ═════════════════════════════════════════════════════════════ */

function parseOmdbRatings(o) {
  if (!o) return null;
  const find = src => (o.Ratings || []).find(r => r.Source === src)?.Value;
  const rt = find('Rotten Tomatoes');
  return {
    imdb: num(o.imdbRating),
    imdbVotes: o.imdbVotes && o.imdbVotes !== 'N/A' ? o.imdbVotes : null,
    rt: rt ? num(rt) : null,
    meta: num(o.Metascore),
    rated: o.Rated && o.Rated !== 'N/A' ? o.Rated : null,
    fetchedAt: Date.now(),
  };
}

// Series-level scores. Needs the IMDb id, which TMDB carries in external_ids.
async function fetchRatings(media, imdbId) {
  if (!imdbId) return null;
  const o = await omdb({ i: imdbId, plot: 'short' });
  const r = parseOmdbRatings(o);
  if (r && state.items[media.key]) {
    state.items[media.key].ratings = r;
    state.items[media.key].imdbId = imdbId;
    save();
  }
  return r;
}

function ratingChips(media, r, details) {
  const chips = [];
  const tmdbScore = details?.vote_average ?? media.tmdbScore;

  if (r?.imdb) chips.push(chip('src-imdb', 'IMDb', r.imdb.toFixed(1), r.imdbVotes ? r.imdbVotes + ' votes' : ''));
  if (r?.rt != null) chips.push(chip('src-rt', 'Rotten Tomatoes', r.rt + '%', 'tomatometer'));
  if (r?.meta != null) chips.push(chip('src-meta', 'Metacritic', r.meta, 'metascore'));
  if (tmdbScore) chips.push(chip('src-tmdb', 'TMDB', tmdbScore.toFixed(1), (details?.vote_count || media.tmdbVotes || 0) + ' votes'));

  const mine = state.items[media.key]?.rating;
  if (mine) chips.push(chip('src-mine', 'Your score', mine + '/10', ''));

  if (!chips.length) {
    return `<p class="notes" style="margin:0 0 18px">
      No external scores yet — ${state.settings.omdbKey
        ? 'IMDb has nothing listed for this one.'
        : 'add an OMDb key in Settings for IMDb, Rotten Tomatoes and Metacritic.'}</p>`;
  }
  return `<div class="rating-row">${chips.join('')}</div>`;
}

function chip(cls, src, val, sub) {
  return `<div class="rating-chip ${cls}">
    <div class="r-src">${esc(src)}</div>
    <div class="r-val">${esc(val)}</div>
    <div class="r-sub">${esc(sub)}</div>
  </div>`;
}

/* ══ Detail modal ════════════════════════════════════════════════════════ */

let openKey = null;
let openDetails = null;   // TMDB details payload for the open title

function openDetail(key) {
  const media = mediaFor(key);
  if (!media) return;
  openKey = key;
  openDetails = null;
  $('#modal').hidden = false;
  document.body.style.overflow = 'hidden';
  renderDetailShell(media);
  loadDetail(media);
}

function closeDetail() {
  $('#modal').hidden = true;
  document.body.style.overflow = '';
  openKey = null;
}

function renderDetailShell(media) {
  const item = state.items[media.key];
  const hero = media.backdrop ? `style="background-image:url('${IMG}w780${media.backdrop}')"` : '';

  $('#modalBody').innerHTML = `
    <div class="detail-hero" ${hero}>
      ${posterHtml(media, 'detail-poster')}
      <div class="detail-head">
        <h2>${esc(media.title)}</h2>
        <div class="detail-sub" id="detailSub">
          ${media.year || '—'} · ${media.mediaType === 'tv' ? 'Series' : 'Film'}${media.isAnime ? ' · Anime' : ''}
        </div>
        <div class="detail-overview">${esc(media.overview) || 'No synopsis on file.'}</div>
      </div>
    </div>
    <div class="detail-body">
      <div id="ratingsSlot"><p class="loading">Fetching ratings…</p></div>
      <div id="controlSlot">${item ? controlsHtml(item) : notInLibraryHtml(media)}</div>
      <div id="episodeSlot"></div>
    </div>`;
}

function notInLibraryHtml(media) {
  return `<div class="control-block">
    <div class="control-row">
      <label>Library</label>
      <button class="btn btn-accent btn-tiny" data-act="add" data-key="${media.key}" data-status="completed">I've watched this</button>
      <button class="btn btn-secondary btn-tiny" data-act="add" data-key="${media.key}" data-status="watching">Watching now</button>
      <button class="btn btn-secondary btn-tiny" data-act="add" data-key="${media.key}" data-status="planned">Plan to watch</button>
    </div>
  </div>`;
}

function controlsHtml(item) {
  const scores = Array.from({ length: 10 }, (_, i) => i + 1).map(n =>
    `<button class="score-btn ${item.rating === n ? 'on' : ''}" data-act="score" data-key="${item.key}" data-score="${n}">${n}</button>`).join('');

  const statusBtns = STATUSES.map(s =>
    `<button class="seg-btn ${item.status === s.id ? 'active' : ''}" data-act="status" data-key="${item.key}" data-status="${s.id}">${s.label}</button>`).join('');

  const tags = (item.tags || []).map(t =>
    `<span class="chip">${esc(t)}<button data-act="untag" data-key="${item.key}" data-tag="${esc(t)}" title="Remove">✕</button></span>`).join('');

  const progress = item.mediaType === 'tv' ? `
    <div class="control-row">
      <label>Progress</label>
      <span class="notes" style="margin:0">S</span>
      <input type="number" min="1" style="width:60px" id="progSeason" value="${item.progress?.season || 1}">
      <span class="notes" style="margin:0">E</span>
      <input type="number" min="0" style="width:60px" id="progEpisode" value="${item.progress?.episode || 0}">
      <button class="btn btn-secondary btn-tiny" data-act="saveprog" data-key="${item.key}">Save</button>
      <button class="btn btn-secondary btn-tiny" data-act="nextep" data-key="${item.key}">+1 episode</button>
    </div>` : '';

  return `<div class="control-block">
    <div class="control-row"><label>Status</label><div class="seg seg-wrap" style="flex:1">${statusBtns}</div></div>
    <div class="control-row"><label>Your score</label><div class="score-picker">${scores}
      ${item.rating ? `<button class="score-btn" data-act="score" data-key="${item.key}" data-score="0" title="Clear">✕</button>` : ''}</div></div>
    ${progress}
    <div class="control-row">
      <label>Sections</label>
      <input type="text" class="tag-input" id="tagInput" placeholder="add a tag — e.g. shonen, comfort, rewatch…">
      <button class="btn btn-secondary btn-tiny" data-act="addtag" data-key="${item.key}">Add</button>
    </div>
    ${tags ? `<div class="control-row"><label></label><div class="chip-row">${tags}</div></div>` : ''}
    <div class="control-row">
      <label>Notes</label>
      <input type="text" class="tag-input" id="noteInput" value="${esc(item.note || '')}" placeholder="anything you want to remember">
      <button class="btn btn-secondary btn-tiny" data-act="savenote" data-key="${item.key}">Save</button>
    </div>
    <div class="control-row">
      <label></label>
      <button class="btn btn-danger btn-tiny" data-act="remove" data-key="${item.key}">Remove from library</button>
    </div>
  </div>`;
}

async function loadDetail(media) {
  let details;
  try {
    details = await tmdb(`/${media.mediaType}/${media.tmdbId}`, { append_to_response: 'external_ids' });
  } catch (e) {
    $('#ratingsSlot').innerHTML = `<div class="err">${esc(e.message)}</div>`;
    return;
  }
  if (openKey !== media.key) return;   // user moved on while we were fetching
  openDetails = details;

  // Genres/anime flag are richer on the details payload than on a search hit.
  const full = normalize(details, media.mediaType);
  if (state.items[media.key]) {
    Object.assign(state.items[media.key], {
      genres: full.genres,
      isAnime: full.isAnime,
      backdrop: full.backdrop || state.items[media.key].backdrop,
      overview: full.overview || state.items[media.key].overview,
    });
    save();
  }

  const bits = [media.year || '—', media.mediaType === 'tv' ? 'Series' : 'Film'];
  if (full.isAnime) bits.push('Anime');
  if (details.number_of_seasons) bits.push(`${details.number_of_seasons} season${details.number_of_seasons > 1 ? 's' : ''}`);
  if (details.number_of_episodes) bits.push(`${details.number_of_episodes} episodes`);
  if (details.runtime) bits.push(`${details.runtime} min`);
  if ((details.genres || []).length) bits.push(details.genres.map(g => g.name).join(', '));
  $('#detailSub').textContent = bits.join(' · ');

  const imdbId = details.external_ids?.imdb_id || details.imdb_id || null;

  let ratings = null;
  try { ratings = await fetchRatings(media, imdbId); } catch (e) { /* ratings are a bonus layer */ }
  if (openKey !== media.key) return;
  $('#ratingsSlot').innerHTML =
    `<div id="chipSlot">${ratingChips(media, ratings, details)}</div>` +
    (imdbId ? `<p class="notes" style="margin-top:-8px;margin-bottom:16px">
       <a href="https://www.imdb.com/title/${imdbId}/" target="_blank" rel="noopener">Open on IMDb</a> ·
       <a href="https://www.themoviedb.org/${media.mediaType}/${media.tmdbId}" target="_blank" rel="noopener">TMDB</a></p>` : '');

  if (media.mediaType === 'tv') renderSeasonPicker(media, details, imdbId);
}

/* ── Episodes ─────────────────────────────────────────────────────────── */

function renderSeasonPicker(media, details, imdbId) {
  const seasons = (details.seasons || []).filter(s => s.season_number > 0 && s.episode_count > 0);
  if (!seasons.length) return;

  const current = state.items[media.key]?.progress?.season;
  const active = seasons.some(s => s.season_number === current) ? current : seasons[0].season_number;

  $('#episodeSlot').innerHTML = `
    <h3 class="panel-title" style="margin-bottom:10px">Episode ratings
      <span class="panel-title-sub">— IMDb per episode, TMDB alongside</span></h3>
    <div class="season-tabs">${seasons.map(s =>
      `<button class="season-tab ${s.season_number === active ? 'active' : ''}"
        data-act="season" data-season="${s.season_number}">S${s.season_number}
        <span style="opacity:.6">(${s.episode_count})</span></button>`).join('')}</div>
    <div id="seasonBody"></div>`;

  $('#episodeSlot').dataset.imdb = imdbId || '';
  loadSeason(media, active, imdbId);
}

async function loadSeason(media, seasonNumber, imdbId) {
  const body = $('#seasonBody');
  if (!body) return;
  body.innerHTML = '<p class="loading">Loading episodes…</p>';

  let tmdbSeason = null, omdbSeason = null;
  try {
    [tmdbSeason, omdbSeason] = await Promise.all([
      tmdb(`/tv/${media.tmdbId}/season/${seasonNumber}`, {}, TTL.season),
      imdbId ? omdb({ i: imdbId, Season: seasonNumber }, TTL.season).catch(() => null) : null,
    ]);
  } catch (e) {
    body.innerHTML = `<div class="err">${esc(e.message)}</div>`;
    return;
  }
  if (openKey !== media.key) return;

  const imdbByEp = new Map();
  for (const ep of (omdbSeason?.Episodes || [])) {
    imdbByEp.set(parseInt(ep.Episode, 10), { rating: num(ep.imdbRating), id: ep.imdbID });
  }

  const episodes = (tmdbSeason.episodes || []).map(ep => ({
    n: ep.episode_number,
    title: ep.name || `Episode ${ep.episode_number}`,
    air: ep.air_date || '',
    tmdb: num(ep.vote_average) || null,
    tmdbVotes: ep.vote_count || 0,
    imdb: imdbByEp.get(ep.episode_number)?.rating ?? null,
    imdbId: imdbByEp.get(ep.episode_number)?.id || null,
  }));

  if (!episodes.length) { body.innerHTML = '<p class="empty">No episodes listed for this season.</p>'; return; }

  const prog = state.items[media.key]?.progress;
  const watchedThrough = prog && prog.season > seasonNumber ? Infinity
    : (prog && prog.season === seasonNumber ? prog.episode : 0);

  const rated = episodes.filter(e => e.imdb ?? e.tmdb);
  const avg = rated.length
    ? (rated.reduce((s, e) => s + (e.imdb ?? e.tmdb), 0) / rated.length) : null;
  const best = rated.length ? rated.reduce((a, b) => ((b.imdb ?? b.tmdb) > (a.imdb ?? a.tmdb) ? b : a)) : null;
  const worst = rated.length ? rated.reduce((a, b) => ((b.imdb ?? b.tmdb) < (a.imdb ?? a.tmdb) ? b : a)) : null;

  const heat = episodes.map(ep => {
    const r = ep.imdb ?? ep.tmdb;
    const watched = ep.n <= watchedThrough;
    if (r == null) {
      return `<div class="ep-cell unrated ${watched ? 'watched' : ''}" data-act="setprog"
        data-season="${seasonNumber}" data-episode="${ep.n}" title="${esc(ep.title)} — no rating yet">
        <span class="ep-n">E${ep.n}</span><span class="ep-r">–</span></div>`;
    }
    return `<div class="ep-cell ${watched ? 'watched' : ''}" style="background:${heatColor(r)}"
      data-act="setprog" data-season="${seasonNumber}" data-episode="${ep.n}"
      title="E${ep.n} · ${esc(ep.title)} — ${r.toFixed(1)} (${ep.imdb ? 'IMDb' : 'TMDB'})${ep.air ? ' · ' + ep.air : ''}">
      <span class="ep-n">E${ep.n}</span><span class="ep-r">${r.toFixed(1)}</span></div>`;
  }).join('');

  const source = imdbByEp.size ? 'IMDb episode scores' :
    (state.settings.omdbKey ? 'TMDB only — IMDb had no episode data for this season' : 'TMDB only — add an OMDb key for IMDb episode scores');

  body.innerHTML = `
    <div class="heatmap">${heat}</div>
    <div class="ep-legend">
      <span>weak</span><span class="legend-bar"></span><span>great</span>
      ${avg ? `<span style="margin-left:8px">season avg <strong style="color:var(--text)">${avg.toFixed(2)}</strong></span>` : ''}
      ${best ? `<span>· best E${best.n} ${(best.imdb ?? best.tmdb).toFixed(1)}</span>` : ''}
      ${worst && worst !== best ? `<span>· weakest E${worst.n} ${(worst.imdb ?? worst.tmdb).toFixed(1)}</span>` : ''}
      <span style="margin-left:auto">${esc(source)} · click a cell to set your progress</span>
    </div>
    <div class="ep-scroll"><table class="ep-table">
      <thead><tr><th class="num">Ep</th><th>Title</th><th>Aired</th><th class="sc">IMDb</th><th class="sc">TMDB</th></tr></thead>
      <tbody>${episodes.map(ep => `
        <tr>
          <td class="num">${ep.n}</td>
          <td class="ttl">${ep.imdbId
            ? `<a href="https://www.imdb.com/title/${ep.imdbId}/" target="_blank" rel="noopener">${esc(ep.title)}</a>`
            : esc(ep.title)}</td>
          <td class="num" style="width:86px">${esc(ep.air || '—')}</td>
          <td class="sc" style="color:${ep.imdb ? heatColor(ep.imdb, true) : 'var(--dim)'}">${ep.imdb ? ep.imdb.toFixed(1) : '—'}</td>
          <td class="sc" style="color:${ep.tmdb ? heatColor(ep.tmdb, true) : 'var(--dim)'}">${ep.tmdb ? ep.tmdb.toFixed(1) : '—'}</td>
        </tr>`).join('')}</tbody>
    </table></div>
    <p class="notes">Rotten Tomatoes scores a series (and films) as a whole — it doesn't publish
      per-episode numbers — so the grid above is IMDb-led, with TMDB filling any gaps.</p>`;
}

// Episode scores cluster between ~6 and ~9.5, so the ramp is stretched over that
// band; a flat 0–10 scale would render almost every show the same shade of green.
function heatColor(r, text = false) {
  const t = Math.max(0, Math.min(1, (r - 5.5) / 4));
  const hue = t * 125;
  return text ? `hsl(${hue} 70% 62%)` : `hsl(${hue} 62% ${46 + t * 8}%)`;
}

/* ══ Settings ════════════════════════════════════════════════════════════ */

function renderSettings() {
  $('#tmdbKey').value = state.settings.tmdbKey;
  $('#omdbKey').value = state.settings.omdbKey;
  const n = Object.keys(cache).length;
  $('#cacheInfo').textContent = `${n} cached API response${n === 1 ? '' : 's'}. ` +
    'Clearing forces fresh ratings on the next open (costs OMDb lookups).';
  $('#keyStatus').textContent = state.settings.tmdbKey
    ? (state.settings.omdbKey ? 'TMDB + OMDb configured — everything is live.'
                              : 'TMDB configured. Add OMDb for IMDb / Rotten Tomatoes scores.')
    : 'No TMDB key yet — search and recommendations are offline.';
  $('#setupBanner').hidden = !!state.settings.tmdbKey;
}

function exportData() {
  const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), ...state }, null, 2)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `watchlist-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data.items) throw new Error('no items in that file');
      const before = Object.keys(state.items).length;
      state.items = Object.assign({}, state.items, data.items);
      state.hidden = Object.assign({}, state.hidden, data.hidden || {});
      // Keys already on this machine win — an old export shouldn't wipe them.
      state.settings = Object.assign({}, data.settings || {}, {
        tmdbKey: state.settings.tmdbKey || data.settings?.tmdbKey || '',
        omdbKey: state.settings.omdbKey || data.settings?.omdbKey || '',
      });
      save();
      renderAll();
      toast(`Imported — library went from ${before} to ${Object.keys(state.items).length}.`);
    } catch (e) {
      toast('That file didn\'t look like a watchlist export.');
    }
  };
  reader.readAsText(file);
}

/* ══ Views ═══════════════════════════════════════════════════════════════ */

function setView(view) {
  ui.view = view;
  $$('.view').forEach(v => { v.hidden = v.id !== 'view-' + view; });
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'settings') renderSettings();
  if (view === 'discover' && !$('#searchGrid').innerHTML) showTrending();
  if (view === 'foryou' && !ui.recs) buildRecs();
  window.scrollTo({ top: 0 });
}

function renderAll() {
  renderSections();
  renderStatusSeg();
  renderStats();
  renderLibrary();
  if (ui.view === 'foryou') renderRecs();
  if (ui.view === 'settings') renderSettings();
}

/* ══ Events ══════════════════════════════════════════════════════════════ */

// One delegated click handler for the whole page: every button carries either a
// data-act (a verb) or a data-* filter, so nothing needs rebinding after render.
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act], [data-section], [data-status], [data-searchtype], [data-recscope], [data-view], [data-goto], .card');
  if (!el) return;

  // Navigation
  if (el.dataset.view) { setView(el.dataset.view); return; }
  if (el.dataset.goto) { setView(el.dataset.goto); return; }

  // Library filters
  if (el.dataset.section && !el.dataset.act) {
    ui.section = el.dataset.section; ui.status = 'all'; renderAll(); return;
  }
  if (el.dataset.status && !el.dataset.act && el.classList.contains('seg-btn') && el.closest('#statusSeg')) {
    ui.status = el.dataset.status; renderAll(); return;
  }
  if (el.dataset.searchtype) { ui.searchType = el.dataset.searchtype; renderSearchSeg(); runSearch(); return; }
  if (el.dataset.recscope) { ui.recScope = el.dataset.recscope; renderRecSeg(); renderRecs(); return; }

  const act = el.dataset.act;
  const key = el.dataset.key;

  switch (act) {
    case 'add': {
      const media = mediaFor(key);
      if (media) addToLibrary(media, el.dataset.status || 'completed');
      if (openKey === key) $('#controlSlot').innerHTML = controlsHtml(state.items[key]);
      if (ui.view === 'discover') runSearch();
      return;
    }
    case 'hide':
      state.hidden[key] = true; save(); renderRecs(); toast('Hidden.'); return;

    case 'status':
      updateItem(key, { status: el.dataset.status });
      if (openKey === key) $('#controlSlot').innerHTML = controlsHtml(state.items[key]);
      return;

    case 'score': {
      const score = parseInt(el.dataset.score, 10);
      updateItem(key, { rating: score || null });
      ui.recs = null;   // your taste changed; the next visit rebuilds
      if (openKey === key) {
        $('#controlSlot').innerHTML = controlsHtml(state.items[key]);
        const chipSlot = $('#chipSlot');
        if (chipSlot) chipSlot.innerHTML = ratingChips(mediaFor(key), state.items[key].ratings, openDetails);
      }
      return;
    }
    case 'addtag': {
      const input = $('#tagInput');
      const tag = input.value.trim().toLowerCase();
      if (!tag) return;
      const item = state.items[key];
      if (!item.tags.includes(tag)) item.tags.push(tag);
      updateItem(key, { tags: item.tags });
      input.value = '';
      $('#controlSlot').innerHTML = controlsHtml(state.items[key]);
      return;
    }
    case 'untag': {
      const item = state.items[key];
      updateItem(key, { tags: item.tags.filter(t => t !== el.dataset.tag) });
      $('#controlSlot').innerHTML = controlsHtml(state.items[key]);
      return;
    }
    case 'savenote':
      updateItem(key, { note: $('#noteInput').value.trim() });
      toast('Note saved.');
      return;

    case 'saveprog': {
      const season = Math.max(1, parseInt($('#progSeason').value, 10) || 1);
      const episode = Math.max(0, parseInt($('#progEpisode').value, 10) || 0);
      updateItem(key, { progress: { season, episode } });
      toast(`Progress: S${season} E${episode}`);
      return;
    }
    case 'nextep': {
      const item = state.items[key];
      const p = item.progress || { season: 1, episode: 0 };
      const next = { season: p.season, episode: p.episode + 1 };
      updateItem(key, { progress: next, status: item.status === 'planned' ? 'watching' : item.status });
      toast(`${item.title} — S${next.season} E${next.episode}`);
      if (openKey === key) {
        $('#controlSlot').innerHTML = controlsHtml(state.items[key]);
        // Keep the heatmap's "watched" outline in step with the new position.
        const tab = $('.season-tab.active');
        if (tab) loadSeason(item, parseInt(tab.dataset.season, 10), $('#episodeSlot').dataset.imdb || null);
      }
      return;
    }
    case 'setprog': {
      const item = state.items[openKey];
      if (!item) { toast('Add this to your library first.'); return; }
      const season = parseInt(el.dataset.season, 10);
      const episode = parseInt(el.dataset.episode, 10);
      updateItem(openKey, {
        progress: { season, episode },
        status: item.status === 'planned' ? 'watching' : item.status,
      });
      $('#controlSlot').innerHTML = controlsHtml(state.items[openKey]);
      loadSeason(item, season, $('#episodeSlot').dataset.imdb || null);
      toast(`Progress: S${season} E${episode}`);
      return;
    }
    case 'season': {
      $$('.season-tab').forEach(t => t.classList.toggle('active', t === el));
      const media = mediaFor(openKey);
      loadSeason(media, parseInt(el.dataset.season, 10), $('#episodeSlot').dataset.imdb || null);
      return;
    }
    case 'remove':
      if (confirm(`Remove ${state.items[key]?.title} from your library?`)) { removeItem(key); closeDetail(); }
      return;
  }

  // Card click (anywhere that isn't one of the buttons above) opens the detail.
  const card = e.target.closest('.card');
  if (card) openDetail(card.dataset.key);
});

function bind() {
  $('#modalClose').addEventListener('click', closeDetail);
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeDetail(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#modal').hidden) closeDetail();
  });

  $('#searchBtn').addEventListener('click', runSearch);
  $('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });

  $('#libraryFilter').addEventListener('input', e => { ui.filter = e.target.value; renderLibrary(); });
  $('#sortSelect').addEventListener('change', e => { ui.sort = e.target.value; renderLibrary(); });

  $('#recRefresh').addEventListener('click', () => {
    // Drop cached recommendation payloads so a rebuild really is a rebuild.
    for (const k of Object.keys(cache)) {
      if (k.includes('/recommendations') || k.includes('/similar')) delete cache[k];
    }
    saveCache();
    ui.recs = null;
    buildRecs();
  });

  $('#saveKeys').addEventListener('click', () => {
    state.settings.tmdbKey = $('#tmdbKey').value.trim();
    state.settings.omdbKey = $('#omdbKey').value.trim();
    save();
    renderSettings();
    toast('Keys saved.');
  });

  $('#exportBtn').addEventListener('click', exportData);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', e => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });

  $('#clearCache').addEventListener('click', () => {
    cache = {};
    localStorage.removeItem(CACHE_KEY);
    renderSettings();
    toast('Ratings cache cleared.');
  });

  $('#clearAll').addEventListener('click', () => {
    if (!confirm('Delete your whole library, tags, scores and keys from this browser?')) return;
    localStorage.removeItem(DB_KEY);
    localStorage.removeItem(CACHE_KEY);
    state = { items: {}, hidden: {}, settings: { tmdbKey: '', omdbKey: '' } };
    cache = {};
    ui.recs = null;
    renderAll();
    renderSettings();
    toast('Everything deleted.');
  });
}

/* ══ Boot ════════════════════════════════════════════════════════════════ */

load();
bind();
renderSearchSeg();
renderRecSeg();
renderAll();
renderSettings();
if (!state.settings.tmdbKey) setView('settings');
