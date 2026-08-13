#!/usr/bin/env node
/**
 * build-spotify-genres.js — regenerate data/spotify-genres.json from the Spotify Web API.
 *
 * Workflow:
 *   1. Put credentials in your shell — never in a committed file:
 *        set -a; source .env.local; set +a
 *      (.env.local is gitignored. Mint a token with scripts/spotify-auth.js.)
 *   2. Run:  node scripts/build-spotify-genres.js
 *      Tuning the taxonomy? Add --cache so reruns hit disk instead of Spotify.
 *   3. Read the "unmatched genres" list in the summary, add rules, rerun.
 *   4. Commit + push. music.html picks up the new data/spotify-genres.json.
 *
 * Genres live on the ARTIST object, not the track — so this pages every source,
 * collects the union of artist ids, and batch-hydrates them 50 at a time.
 *
 * Flags:
 *   --selftest          run the taxonomy fixtures offline and exit (no network)
 *   --explain <genre>   print which rule classifies one genre and exit
 *   --cache             read/write raw API responses under .cache/spotify/
 *   --cache-only        never call Spotify; build from cache alone. Use when
 *                       rate-limited — genre lookups still run normally.
 *   --limit <n>         stop after n saved tracks (fast iteration)
 *   --no-playlists      skip the slowest crawl
 *   --dry-run           compute and log, write nothing
 *   --out <path>        override the output path
 *   --playlist-names <omit|full>   default omit; this repo is public
 *   --no-musicbrainz    skip the slow fallback; faster, thinner genre coverage
 *   --no-discovery      skip the Last.fm suggestion lookups
 *
 * Data sources: Spotify supplies WHAT you listened to. Genres come from Last.fm
 * (falling back to MusicBrainz) because Spotify removed the artist `genres`
 * field — its docs still list it, the live API no longer returns it.
 * Needs LASTFM_API_KEY (free, no OAuth: https://www.last.fm/api/account/create).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---------- config ------------------------------------------------------

const SCHEMA_VERSION = 1;
const RULES_VERSION = 1;

const API = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

const ROOT = path.join(__dirname, "..");
const DEFAULT_OUT = path.join(ROOT, "data", "spotify-genres.json");
const CACHE_DIR = path.join(ROOT, ".cache", "spotify");
const ARTIST_CACHE = path.join(CACHE_DIR, "artist-genres.json");
const SUGGEST_CACHE = path.join(CACHE_DIR, "suggestions.json");

const MIN_INTERVAL_MS = 120; // self-pacing gap between serial requests
const REQ_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 5;
const MAX_RETRY_AFTER_S = 60; // longer than this, abort rather than sleep
const TOKEN_SKEW_MS = 120000; // refresh this long before expiry

const MAX_PLAYLIST_ITEMS = 1000; // cap per playlist
const SKIP_PLAYLIST_OVER = 2500; // skip monster followed playlists entirely
const TOP_GENRES_PER_BLOCK = 150;
const TOP_ARTISTS_EMITTED = 120;
const MAX_UNMATCHED_LISTED = 200;
const EXAMPLES_PER_GENRE = 8;
const DISCOVERY_SEEDS = 60;        // most-played artists used as similarity seeds
const CONSENSUS_MAX = 18;   // named by all three
const SOLO_PER_ENGINE = 6;  // named by exactly one
const SUGGESTIONS_PER_GENRE = 6;

const MIN_GENRE_ARTISTS = 3;
const MIN_EDGE_ARTISTS = 3;
const MAX_EDGES = 600;

// MusicBrainz requires a descriptive User-Agent identifying the app + contact.
const MB_USER_AGENT = "typride-genre-viz/1.0 ( https://typride.github.io )";
const MB_FALLBACK = !process.argv.includes("--no-musicbrainz");

// Spotify id -> artist name, harvested from track objects as they stream past.
const artistNames = new Map();

// Filled from the API's own `total` on /me/tracks.
const savedTotals = { total: null };

const UNCLASSIFIED = "__unclassified__";
const FAMILY_UNCLASSIFIED = "Unclassified";
const FAMILY_OTHER = "Other";

const COMBINE_SOURCES = ["saved", "playlistsOwned", "topTracks", "topArtists", "recent"];

const FAMILIES = [
  "Ambient / Experimental",
  "Blues",
  "Classical",
  "Electronic",
  "Folk / Country",
  "Global",
  "Hip Hop",
  "Jazz",
  "Latin",
  "Metal",
  "Pop",
  "Punk",
  "R&B / Soul",
  "Reggae / Caribbean",
  "Rock",
];

const stats = {
  requests: 0,
  retries: 0,
  rateLimited: 0,
  cacheHits: 0,
  cacheMisses: 0,
  nullItems: 0,
  skippedEpisodes: 0,
  skippedLocal: 0,
  skippedNoArtist: 0,
  playlistsForbidden: 0,
  playlistsMissing: 0,
  playlistsOversize: 0,
  lastfmRequests: 0,
  lastfmRateLimited: 0,
  lastfmResolved: 0,
  mbRequests: 0,
  deezerRequests: 0,
  lbRequests: 0,
  mbResolved: 0,
  unresolved: 0,
  warnings: [],
};

// ---------- cli ---------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    selftest: false,
    explain: null,
    cache: false,
    limit: Infinity,
    playlists: true,
    dryRun: false,
    out: DEFAULT_OUT,
    playlistNames: "omit",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selftest") opts.selftest = true;
    else if (a === "--explain") opts.explain = argv[++i];
    else if (a === "--cache") opts.cache = true;
    else if (a === "--cache-only") { opts.cache = true; opts.cacheOnly = true; }
    else if (a === "--limit") opts.limit = Number(argv[++i]) || Infinity;
    else if (a === "--no-playlists") opts.playlists = false;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--out") opts.out = path.resolve(argv[++i]);
    else if (a === "--playlist-names") opts.playlistNames = argv[++i];
    else if (a === "--no-musicbrainz") opts.noMusicbrainz = true; // read via MB_FALLBACK
    else if (a === "--no-discovery") opts.noDiscovery = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!["omit", "full"].includes(opts.playlistNames)) {
    throw new Error(`--playlist-names must be "omit" or "full"`);
  }
  return opts;
}

// ---------- auth --------------------------------------------------------

let tokenState = { token: null, expiresAt: 0, inflight: null };

function requireEnv() {
  const env = {
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    refreshToken: process.env.SPOTIFY_REFRESH_TOKEN,
    // Spotify no longer returns artist genres, so genre data comes from Last.fm.
    // Free key, no OAuth: https://www.last.fm/api/account/create
    lastfmKey: process.env.LASTFM_API_KEY,
  };
  // LASTFM_API_KEY is deliberately OPTIONAL. Without it the run falls back to
  // MusicBrainz alone — no API key of any kind, just much slower (1 req/sec).
  const missing = Object.entries({
    SPOTIFY_CLIENT_ID: env.clientId,
    SPOTIFY_CLIENT_SECRET: env.clientSecret,
    SPOTIFY_REFRESH_TOKEN: env.refreshToken,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  // Names only — never a value or a prefix.
  if (missing.length) throw new Error(`missing env var(s): ${missing.join(", ")}`);

  // Shape checks catch the usual copy-paste damage (wrapping quotes, a trailing
  // space, a newline pasted mid-token) without ever revealing a value.
  const shapeProblems = [];
  Object.entries({
    SPOTIFY_CLIENT_ID: env.clientId,
    SPOTIFY_CLIENT_SECRET: env.clientSecret,
    SPOTIFY_REFRESH_TOKEN: env.refreshToken,
  }).forEach(([name, val]) => {
    if (/^["']|["']$/.test(val)) shapeProblems.push(`${name} is wrapped in quotes — remove them`);
    else if (val !== val.trim()) shapeProblems.push(`${name} has leading/trailing whitespace`);
    else if (/\s/.test(val)) shapeProblems.push(`${name} contains a space or newline — it was probably line-wrapped on copy`);
  });
  if (env.clientId && env.clientId.length !== 32) {
    shapeProblems.push(`SPOTIFY_CLIENT_ID should be 32 chars, got ${env.clientId.length}`);
  }
  if (env.refreshToken && env.refreshToken.length < 80) {
    shapeProblems.push(`SPOTIFY_REFRESH_TOKEN looks short (${env.refreshToken.length} chars) — likely truncated on copy`);
  }
  if (shapeProblems.length) {
    throw new Error("credential formatting problem(s):\n  " + shapeProblems.join("\n  "));
  }

  return env;
}

async function refreshAccessToken(env) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " + Buffer.from(`${env.clientId}:${env.clientSecret}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env.refreshToken,
    }),
  });
  if (!res.ok) {
    // Surface Spotify's error slug — "invalid_grant" (bad/mangled refresh token)
    // and "invalid_client" (bad id/secret) need completely different fixes, and
    // a bare 400 can't tell you which. Never log the credential values.
    let slug = "";
    try {
      const err = await res.json();
      slug = err.error_description || err.error || "";
    } catch (e) {
      /* non-JSON error body — the status is all we get */
    }
    const hint =
      /invalid_grant/i.test(slug)
        ? "\n  The refresh token is rejected. Most likely it was truncated or picked up a\n" +
          "  stray space/newline on copy. Re-copy it, or re-mint: node scripts/spotify-auth.js"
        : /invalid_client/i.test(slug)
        ? "\n  Client id/secret rejected. Check SPOTIFY_CLIENT_SECRET matches this app in\n" +
          "  the Spotify dashboard, and that SPOTIFY_CLIENT_ID is the same app."
        : "";
    throw new Error(`token refresh failed: ${res.status}${slug ? ` (${slug})` : ""}${hint}`);
  }
  const data = await res.json();
  return {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

async function ensureToken(env, force) {
  if (!force && tokenState.token && Date.now() < tokenState.expiresAt - TOKEN_SKEW_MS) {
    return tokenState.token;
  }
  // De-dupe concurrent refreshes so a 401 storm can't hammer the token endpoint.
  if (!tokenState.inflight) {
    tokenState.inflight = refreshAccessToken(env)
      .then((next) => {
        tokenState = { ...next, inflight: null };
        return next.token;
      })
      .catch((err) => {
        tokenState.inflight = null;
        throw err;
      });
  }
  return tokenState.inflight;
}

const SCOPE_PROBES = [
  ["user-library-read", "/me/tracks?limit=1"],
  ["playlist-read-private", "/me/playlists?limit=1"],
  ["user-top-read", "/me/top/artists?limit=1"],
  ["user-read-recently-played", "/me/player/recently-played?limit=1"],
];

async function preflightScopes(env, opts = {}) {
  const missing = [];
  for (const [scope, probe] of SCOPE_PROBES) {
    try {
      await spotifyFetch(env, probe, opts);
    } catch (err) {
      if (err.status === 403) missing.push(scope);
      else throw err;
    }
  }
  if (missing.length) {
    throw new Error(
      `refresh token is missing scope(s): ${missing.join(", ")}\n` +
        `  Re-mint one with:  node scripts/spotify-auth.js\n` +
        `  then update it:    cd workers/spotify && wrangler secret put SPOTIFY_REFRESH_TOKEN`
    );
  }
}

// ---------- http core ---------------------------------------------------

let lastRequestAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cachePathFor(url) {
  return path.join(CACHE_DIR, crypto.createHash("sha1").update(url).digest("hex") + ".json");
}

async function spotifyFetch(env, pathOrUrl, opts = {}) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : API + pathOrUrl;

  if (opts.cache || opts.cacheOnly) {
    const cp = cachePathFor(url);
    try {
      const hit = JSON.parse(fs.readFileSync(cp, "utf8"));
      stats.cacheHits++;
      return hit;
    } catch (e) {
      /* cache miss — fall through to the network */
    }
  }

  // --cache-only: never touch Spotify. Lets a build complete from whatever is
  // already cached while the app is rate-limited (Spotify's dev-mode daily cap
  // is measured in hours). Genre lookups hit Last.fm/MusicBrainz and are
  // unaffected, so the taxonomy can still be tuned.
  if (opts.cacheOnly) {
    stats.cacheMisses++;
    return null;
  }

  let attempt = 0;
  let refreshedOn401 = false;

  for (;;) {
    const token = await ensureToken(env, false);

    const gap = Date.now() - lastRequestAt;
    if (gap < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - gap);
    lastRequestAt = Date.now();

    let res;
    try {
      stats.requests++;
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      });
    } catch (err) {
      if (++attempt >= MAX_ATTEMPTS) {
        const e = new Error(`network error after ${attempt} attempts: ${err.message}`);
        e.status = 0;
        throw e;
      }
      stats.retries++;
      await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
      continue;
    }

    if (res.status === 200 || res.status === 201) {
      const data = await res.json();
      if (opts.cache) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cachePathFor(url), JSON.stringify(data));
      }
      return data;
    }

    if (res.status === 204) return null;

    if (res.status === 401 && !refreshedOn401) {
      // Expired mid-run. Force one refresh; a second 401 is a credential problem.
      refreshedOn401 = true;
      await ensureToken(env, true);
      continue;
    }

    if (res.status === 403) {
      const e = new Error(`403 Forbidden: ${redactUrl(url)}${await errorDetail(res)}`);
      e.status = 403;
      throw e;
    }

    if (res.status === 404) {
      if (opts.allow404) return null;
      const e = new Error(`404 Not Found: ${redactUrl(url)}`);
      e.status = 404;
      throw e;
    }

    if (res.status === 429) {
      stats.rateLimited++;
      const wait = Number(res.headers.get("retry-after")) || 2 ** attempt;
      if (wait > MAX_RETRY_AFTER_S) {
        const e = new Error(
          `Spotify is rate-limiting hard (Retry-After ${wait}s). ` +
            `Wait a few minutes and rerun with --cache to resume cheaply.`
        );
        e.status = 429;
        throw e;
      }
      await sleep(wait * 1000 + Math.floor(Math.random() * 250));
      continue; // 429 does not consume an attempt
    }

    if (++attempt >= MAX_ATTEMPTS) {
      const e = new Error(`${res.status} after ${attempt} attempts: ${redactUrl(url)}`);
      e.status = res.status;
      throw e;
    }
    stats.retries++;
    await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
  }
}

function redactUrl(url) {
  return url.replace(/ids=[^&]*/, "ids=…");
}

// Spotify puts the actual reason in the body. Without it a bare 403 is
// unactionable — "insufficient client scope" and a deprecated endpoint look
// identical. Never echoes credentials; the body carries none.
async function errorDetail(res) {
  try {
    const text = await res.text();
    if (!text) return "";
    try {
      const j = JSON.parse(text);
      const msg = (j.error && (j.error.message || j.error_description)) || j.error_description || j.error;
      return msg ? ` — ${typeof msg === "string" ? msg : JSON.stringify(msg)}` : ` — ${text.slice(0, 200)}`;
    } catch (e) {
      return ` — ${text.slice(0, 200)}`;
    }
  } catch (e) {
    return "";
  }
}

async function getPaged(env, firstUrl, opts = {}) {
  const max = opts.max || Infinity;
  const out = [];
  let url = firstUrl;
  while (url && out.length < max) {
    const page = await spotifyFetch(env, url, opts);
    if (!page) break;
    // Record what the API says exists, so a --limit build can report that it
    // sampled rather than presenting the cap as the real size of the library.
    if (opts.totals && page.total != null && opts.totals.total == null) {
      opts.totals.total = page.total;
    }
    const items = page.items || [];
    out.push(...items);
    if (opts.onPage) opts.onPage(out.length);
    url = page.next;
  }
  return out.slice(0, max === Infinity ? out.length : max);
}

// ---------- fetchers ----------------------------------------------------

// Playlist and recently-played pages wrap the track in an envelope. That
// envelope's key changed in Feb 2026 (`tracks` -> `items` on the playlist
// object), so don't assume `.track` — take whichever shape came back, and
// report the shape once if it's something new.
let unwrapReported = false;
function unwrapItem(i) {
  if (!i || typeof i !== "object") return null;
  const inner = i.track || i.item || i.episode || null;
  if (inner) return inner;
  // Already a bare track object?
  if (i.type === "track" || (i.artists && i.name)) return i;
  // A known envelope whose payload is null: a track removed from the catalogue
  // or unavailable in this market. Expected, not a shape change.
  if ("item" in i || "track" in i || "episode" in i) {
    stats.nullItems++;
    return null;
  }
  if (!unwrapReported) {
    unwrapReported = true;
    const keys = Object.keys(i);
    stats.warnings.push(
      `unrecognised playlist item shape — keys: [${keys.join(", ") || "none"}]`
    );
  }
  return null;
}

function normalizeTrack(raw) {
  if (!raw) return null;
  // Podcasts carry no genres and would read as "unclassified listening".
  if (raw.type === "episode") {
    stats.skippedEpisodes++;
    return null;
  }
  if (raw.is_local) {
    stats.skippedLocal++;
    return null;
  }
  // Spotify's track objects carry artist NAMES as well as ids. Since genres now
  // come from Last.fm/MusicBrainz (Spotify dropped the field entirely), those
  // names are all we need — no per-artist Spotify call at all.
  (raw.artists || []).forEach((a) => {
    if (a && a.id && a.name && !artistNames.has(a.id)) artistNames.set(a.id, a.name);
  });
  const artistIds = [...new Set((raw.artists || []).map((a) => a && a.id).filter(Boolean))];
  if (!artistIds.length) {
    stats.skippedNoArtist++;
    return null;
  }
  return { id: raw.id || null, name: raw.name || "", artistIds };
}

async function fetchMe(env, opts) {
  const me = await spotifyFetch(env, "/me", opts);
  if (!me) {
    throw new Error(
      "/me is not in the cache — --cache-only needs at least one normal run first"
    );
  }
  return { id: me.id, displayName: me.display_name || null, country: me.country || null };
}

async function fetchSavedTracks(env, opts) {
  const items = await getPaged(env, `${API}/me/tracks?limit=50`, {
    ...opts,
    totals: savedTotals,
    max: opts.limit,
    onPage: (n) => process.stdout.write(`\r  saved tracks… ${n}`),
  });
  process.stdout.write("\r");
  return items.map((i) => normalizeTrack(i && i.track)).filter(Boolean);
}

// Feb 2026 renamed the playlist object's `tracks` field to `items`. Read the href
// off whichever shape came back rather than hardcoding the path.
function pickPlaylistItemsRef(pl) {
  const ref = pl.items || pl.tracks || null;
  if (pl.tracks && !pl.items && !stats._legacyPlaylistWarned) {
    stats._legacyPlaylistWarned = true;
    stats.warnings.push("playlist objects still use the legacy `tracks` field");
  }
  return ref ? { href: ref.href, total: ref.total || 0 } : null;
}

async function fetchPlaylists(env, meId, opts) {
  const raw = await getPaged(env, `${API}/me/playlists?limit=50`, opts);
  return raw
    .filter(Boolean)
    .filter((pl) => {
      // Spotify's own editorial/algorithmic playlists 403 for apps without
      // extended quota. Skipping them by owner saves ~50 doomed requests per
      // run — which matters, because the dev-mode daily cap is easy to hit.
      if (pl.owner && pl.owner.id === "spotify") {
        stats.playlistsForbidden++;
        return false;
      }
      return true;
    })
    .map((pl) => {
      const ref = pickPlaylistItemsRef(pl);
      if (!ref || !ref.href) return null;
      return {
        id: pl.id,
        name: pl.name || "",
        owned: !!(pl.owner && pl.owner.id === meId),
        collaborative: !!pl.collaborative,
        href: ref.href,
        total: ref.total,
      };
    })
    .filter(Boolean);
}

async function fetchPlaylistItems(env, pl, opts) {
  if (pl.total > SKIP_PLAYLIST_OVER) {
    stats.playlistsOversize++;
    stats.warnings.push(`one or more playlists skipped for exceeding ${SKIP_PLAYLIST_OVER} items`);
    return { tracks: [], truncated: true, skipped: true };
  }
  // NO `fields=` mask. The Feb 2026 rename changed the item wrapper's shape, and
  // a mask that doesn't match silently returns a full page of EMPTY objects —
  // items present, every one of them `{}`, no error. Costs bandwidth; correct.
  const sep = pl.href.includes("?") ? "&" : "?";
  const url = `${pl.href}${sep}limit=50`;
  let items;
  try {
    items = await getPaged(env, url, { ...opts, allow404: true, max: MAX_PLAYLIST_ITEMS });
  } catch (err) {
    // 403 here is NOT a scope problem — preflight already cleared the scopes.
    // Spotify's Nov 2024 lockdown makes its own editorial/algorithmic playlists
    // (Discover Weekly, Daily Mixes, editorial lists) unreadable to apps without
    // extended quota. One of those must not abort the whole crawl.
    if (err.status === 403) {
      stats.playlistsForbidden++;
      stats.warnings.push(
        "one or more followed playlists are Spotify-owned (editorial/algorithmic) " +
          "and unreadable via the API — excluded from the counts"
      );
      return { tracks: [], truncated: false, skipped: true };
    }
    if (err.status === 404) {
      stats.playlistsMissing++;
      stats.warnings.push("one or more playlists returned 404 (deleted or unavailable)");
      return { tracks: [], truncated: false, skipped: true };
    }
    throw err;
  }
  const truncated = pl.total > MAX_PLAYLIST_ITEMS;
  if (truncated) stats.warnings.push(`a playlist was truncated at ${MAX_PLAYLIST_ITEMS} items`);
  return {
    tracks: items.map((i) => normalizeTrack(unwrapItem(i))).filter(Boolean),
    truncated,
    skipped: false,
  };
}

async function fetchTop(env, type, timeRange, opts) {
  const data = await spotifyFetch(
    env,
    `/me/top/${type}?limit=50&time_range=${timeRange}`,
    opts
  );
  return (data && data.items) || [];
}

async function fetchRecent(env, opts) {
  const data = await spotifyFetch(env, "/me/player/recently-played?limit=50", opts);
  return ((data && data.items) || []).map((i) => normalizeTrack(unwrapItem(i))).filter(Boolean);
}

function loadArtistCache() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(ARTIST_CACHE, "utf8"))));
  } catch (e) {
    return new Map();
  }
}

function saveArtistCache(index) {
  const obj = {};
  [...index.keys()].sort().forEach((id) => {
    const a = index.get(id);
    obj[id] = { name: a.name, genres: a.genres, source: a.source || "none" };
  });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(ARTIST_CACHE, JSON.stringify(obj, null, 2) + "\n");
}

// ---------- genre providers ---------------------------------------------
//
// Spotify REMOVED the artist `genres` field (its docs still list it; the live
// API does not return it). Verified empirically: a Get Artist response now
// contains only external_urls/href/id/images/name/type/uri. So genres come from
// Last.fm's crowd tags, falling back to MusicBrainz. Both are matched on the
// artist NAME, which is the accuracy limit of this whole page — same-named
// artists will collide, and the page says so.

// Last.fm's most common tags are not genres. Without this the charts fill up
// with "seen live" and "female vocalists".
const TAG_STOPLIST = new Set([
  "seen live", "favorites", "favourites", "favorite", "favourite",
  "favorite songs", "favourite songs", "my favorites", "my favourites",
  "female vocalists", "male vocalists", "female vocalist", "male vocalist",
  "female fronted", "beautiful", "awesome", "amazing", "love", "loved",
  "love at first listen", "best", "cool", "great", "good", "epic", "perfect",
  "sexy", "catchy", "masterpiece", "albums i own", "vinyl", "spotify",
  "under 2000 listeners", "check out", "want to see live", "radio",
  "banger", "bangers", "songs", "song", "music", "band", "bands",
  "solo artist", "composer", "producer", "singer", "singer songwriter fem",
  "10s", "00s", "90s", "80s", "70s", "60s", "50s", "20s",
  "2000s", "2010s", "2020s", "1990s", "1980s", "1970s", "1960s",
  "21st century", "20th century", "new", "old", "classic", "modern",
  "chill", "chillout", "mellow", "relax", "relaxing", "happy", "sad",
  "melancholy", "melancholic", "energetic", "upbeat", "dark", "atmospheric",
  "instrumental", "acoustic", "live", "cover", "remix", "soundtrack music",
  "all", "other", "misc", "various", "unknown",
  // Nationality and place tags are the single biggest source of noise in
  // Last.fm data — they describe where an artist is from, not what they sound
  // like. Compound forms that DO carry genre meaning ("brazilian funk",
  // "musica mexicana") are matched by the taxonomy before this list applies.
  "american", "america", "usa", "us", "british", "britain", "uk",
  "united kingdom", "english", "england", "scottish", "scotland", "irish",
  "ireland", "welsh", "wales", "german", "germany", "deutsch", "french",
  "france", "francais", "canadian", "canada", "quebec", "australian",
  "australia", "swedish", "sweden", "norwegian", "norway", "danish",
  "denmark", "finnish", "finland", "icelandic", "iceland", "dutch",
  "netherlands", "belgian", "belgium", "spanish", "spain", "italian",
  "italy", "portuguese", "portugal", "polish", "poland", "russian",
  "russia", "japanese", "japan", "korean", "korea", "chinese", "china",
  "taiwanese", "indian", "india", "brazilian", "brazil", "mexican",
  "mexico", "argentinian", "argentina", "chilean", "colombian", "cuban",
  "jamaican", "african", "south african", "nigerian", "israeli", "turkish",
  "greek", "swiss", "austrian", "czech", "hungarian", "romanian",
  "ukrainian", "new zealand", "kiwi", "scandinavian", "nordic", "european",
  "latin american", "asian", "los angeles", "new york", "london", "berlin",
  "chicago", "detroit", "seattle", "portland", "austin", "nashville tn",
  "toronto", "montreal", "melbourne", "sydney", "bristol", "manchester",
  "glasgow", "dublin", "paris", "tokyo", "seoul",
  "united states", "great britain", "brasil", "nigeria", "nigerian", "mali",
  "ethiopia", "ethiopian", "ghana", "ghanaian", "senegal", "kenya", "cuba",
  "west coast", "east coast", "midwest",
  // Instruments describe how a record was made, not what genre it is. Bare
  // "piano" was the single largest unmatched tag by weight; "solo piano" and
  // "piano house" are still matched as compounds before this list applies.
  "guitar", "guitars", "saxophone", "sax", "trumpet", "bass", "drums",
  "violin", "cello", "flute", "harp", "organ", "synth", "synths", "keyboard",
  "vocal", "vocals", "voice", "harmonica", "strings",
  // Scene / quality descriptors that aren't genres
  "underground", "obscure", "indie label", "self released", "unsigned",
  "lyrics", "melodic", "genre", "genres", "favorite artists",
  "puerto rico", "south africa", "california", "jewish", "conductor",
  "ofwgkta", "birp", "damiancore", "calabash", "composers", "orchestras",
  "malaysian", "malaysia", "colombia", "colombian", "turkey", "lebanon",
  "lebanese", "bay area", "los panchos", "peru", "peruvian", "venezuela",
  "indonesia", "indonesian", "thailand", "vietnam", "philippines",
]);

const LASTFM_MIN_TAG_COUNT = 15; // 0-100 relative popularity
const LASTFM_MAX_TAGS = 8;

function cleanTags(tags) {
  const out = [];
  for (const t of tags) {
    const name = String(t || "").toLowerCase().trim();
    if (!name || name.length > 40) continue;
    if (TAG_STOPLIST.has(name)) continue;
    if (/^\d+$/.test(name)) continue; // bare years
    if (out.indexOf(name) === -1) out.push(name);
    if (out.length >= LASTFM_MAX_TAGS) break;
  }
  return out.sort();
}

// One gate per host — MusicBrainz's 1 req/sec must not throttle Last.fm or Deezer.
const paceGates = {};
async function pacedBy(host, ms, fn) {
  const last = paceGates[host] || 0;
  const gap = Date.now() - last;
  if (gap < ms) await sleep(ms - gap);
  paceGates[host] = Date.now();
  return fn();
}
async function paced(ms, fn) {
  return pacedBy(ms >= 1000 ? "musicbrainz" : "lastfm", ms, fn);
}

async function lastfmTags(env, name) {
  const url =
    "https://ws.audioscrobbler.com/2.0/?method=artist.gettoptags&autocorrect=1" +
    `&artist=${encodeURIComponent(name)}&api_key=${env.lastfmKey}&format=json`;
  // Last.fm tolerates roughly 5 req/sec.
  const res = await paced(210, () => fetch(url, { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) }));
  stats.lastfmRequests++;
  if (res.status === 429) {
    stats.lastfmRateLimited++;
    await sleep(3000);
    return null;
  }
  if (!res.ok) return null;
  const data = await res.json();
  if (data && data.error) return null; // 6 = artist not found
  const raw = (data && data.toptags && data.toptags.tag) || [];
  const list = Array.isArray(raw) ? raw : [raw];
  return cleanTags(
    list.filter((t) => Number(t && t.count) >= LASTFM_MIN_TAG_COUNT).map((t) => t && t.name)
  );
}

// ---------- discovery ----------------------------------------------------
//
// Spotify's /recommendations and /related-artists are both dead, so suggestions
// come from Last.fm: similar-artist lookups seeded from what's actually played,
// plus per-genre top artists. Everything already in the library is filtered out
// by normalised name — the whole point is what ISN'T there.

function normName(n) {
  return String(n || "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

async function lastfmSimilar(env, name) {
  const url =
    "https://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&autocorrect=1&limit=25" +
    `&artist=${encodeURIComponent(name)}&api_key=${env.lastfmKey}&format=json`;
  const res = await paced(210, () => fetch(url, { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) }));
  stats.lastfmRequests++;
  if (!res.ok) return [];
  const data = await res.json();
  const raw = (data && data.similarartists && data.similarartists.artist) || [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .filter((a) => a && a.name)
    .map((a) => ({ name: a.name, match: Number(a.match) || 0 }));
}

async function lastfmTagTopArtists(env, tag) {
  const url =
    "https://ws.audioscrobbler.com/2.0/?method=tag.gettopartists&limit=25" +
    `&tag=${encodeURIComponent(tag)}&api_key=${env.lastfmKey}&format=json`;
  const res = await paced(210, () => fetch(url, { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) }));
  stats.lastfmRequests++;
  if (!res.ok) return [];
  const data = await res.json();
  const raw = (data && data.topartists && data.topartists.artist) || [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((a) => a && a.name).map((a) => a.name);
}

// Deezer: public, no key, its own collaborative filtering over streaming
// behaviour. Two calls per artist (search for the id, then related).
async function deezerRelated(name) {
  const sUrl = "https://api.deezer.com/search/artist?limit=1&q=" + encodeURIComponent(name);
  const sRes = await pacedBy("deezer", 260, () => fetch(sUrl, { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) }));
  stats.deezerRequests++;
  if (!sRes.ok) return [];
  const sJson = await sRes.json();
  const hit = sJson && sJson.data && sJson.data[0];
  // Guard against fuzzy search drift — only trust a real name match.
  if (!hit || !hit.id || normName(hit.name) !== normName(name)) return [];
  const rRes = await pacedBy("deezer", 260, () =>
    fetch(`https://api.deezer.com/artist/${hit.id}/related?limit=25`, { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) }));
  stats.deezerRequests++;
  if (!rRes.ok) return [];
  const rJson = await rRes.json();
  return ((rJson && rJson.data) || []).filter((a) => a && a.name).map((a) => a.name);
}

// ListenBrainz: open listen data from MetaBrainz, keyed by MusicBrainz id — so
// it needs an MBID lookup first, which is the slow part (1 req/sec).
const LB_ALGORITHM =
  "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30";

async function musicbrainzMbid(name) {
  const url = "https://musicbrainz.org/ws/2/artist?fmt=json&limit=1&query=" +
    encodeURIComponent(`artist:"${name}"`);
  const res = await pacedBy("musicbrainz", 1100, () =>
    fetch(url, { headers: { "User-Agent": MB_USER_AGENT, Accept: "application/json" },
                 signal: AbortSignal.timeout(REQ_TIMEOUT_MS) }));
  stats.mbRequests++;
  if (!res.ok) return null;
  const j = await res.json();
  const hit = j && j.artists && j.artists[0];
  return hit && Number(hit.score) >= 90 ? hit.id : null;
}

async function listenbrainzSimilar(mbid) {
  const url = `https://labs.api.listenbrainz.org/similar-artists/json?artist_mbids=${mbid}` +
    `&algorithm=${LB_ALGORITHM}`;
  const res = await pacedBy("listenbrainz", 260, () =>
    fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) }));
  stats.lbRequests++;
  if (!res.ok) return [];
  const j = await res.json();
  return (Array.isArray(j) ? j : []).filter((a) => a && a.name).slice(0, 25).map((a) => a.name);
}

function loadSuggestCache() {
  try {
    return JSON.parse(fs.readFileSync(SUGGEST_CACHE, "utf8"));
  } catch (e) {
    return { similar: {}, tags: {}, deezer: {}, lb: {}, mbid: {} };
  }
}

function saveSuggestCache(c) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const out = { similar: {}, tags: {}, deezer: {}, lb: {}, mbid: {} };
  ["similar", "tags", "deezer", "lb", "mbid"].forEach((sec) => {
    Object.keys(c[sec] || {}).sort().forEach((k) => (out[sec][k] = c[sec][k]));
  });
  fs.writeFileSync(SUGGEST_CACHE, JSON.stringify(out, null, 2) + "\n");
}

async function buildDiscovery(env, artistIndex, artistMass, genres) {
  const empty = { discovery: [], genreSuggestions: {}, engines: {}, overlap: [], seeded: 0 };
  if (!env.lastfmKey) return empty;

  const known = new Set();
  artistIndex.forEach((a) => { if (a.name) known.add(normName(a.name)); });

  const cache = loadSuggestCache();
  const massById = new Map(artistMass);
  const seeds = [...massById.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, DISCOVERY_SEEDS)
    .map(([id, mass]) => ({ artist: artistIndex.get(id), mass }))
    .filter((x) => x.artist && x.artist.name);

  console.log(
    `  discovery: 3 engines over ${seeds.length} seed artist(s) + ${genres.length} genre(s)`
  );

  // engine key -> Map<normName, {name, score, via:[]}>
  const ENGINES = ["lastfm", "deezer", "listenbrainz"];
  const found = {};
  ENGINES.forEach((e) => (found[e] = new Map()));

  function record(engine, seedName, seedMass, name, weight) {
    const nk = normName(name);
    // The whole point is what ISN'T already in the library.
    if (!nk || known.has(nk)) return;
    const m = found[engine];
    const e = m.get(nk) || { name: name, score: 0, via: [] };
    e.score += weight * Math.log1p(seedMass);
    if (e.via.length < 3 && e.via.indexOf(seedName) === -1) e.via.push(seedName);
    m.set(nk, e);
  }

  for (let i = 0; i < seeds.length; i++) {
    const { artist: seed, mass } = seeds[i];
    const key = normName(seed.name);

    // --- Last.fm: collaborative filtering over scrobbles
    let sims = cache.similar[key];
    if (!sims) {
      try { sims = await lastfmSimilar(env, seed.name); } catch (e) { sims = []; }
      cache.similar[key] = sims;
    }
    sims.forEach((sm) => record("lastfm", seed.name, mass, sm.name, sm.match || 0.1));

    // --- Deezer: its own CF over streaming behaviour
    let dz = cache.deezer[key];
    if (!dz) {
      try { dz = await deezerRelated(seed.name); } catch (e) { dz = []; }
      cache.deezer[key] = dz;
    }
    // Deezer returns a ranked list with no score; decay by position.
    dz.forEach((n, idx) => record("deezer", seed.name, mass, n, 1 / (idx + 2)));

    // --- ListenBrainz: open listen data, needs an MBID first
    if (!(key in cache.mbid)) {
      try { cache.mbid[key] = await musicbrainzMbid(seed.name); } catch (e) { cache.mbid[key] = null; }
    }
    const mbid = cache.mbid[key];
    if (mbid) {
      let lb = cache.lb[key];
      if (!lb) {
        try { lb = await listenbrainzSimilar(mbid); } catch (e) { lb = []; }
        cache.lb[key] = lb;
      }
      lb.forEach((n, idx) => record("listenbrainz", seed.name, mass, n, 1 / (idx + 2)));
    }

    if (i % 5 === 0) {
      process.stdout.write(
        `\r  discovery… seed ${i + 1}/${seeds.length}  ` +
          ENGINES.map((e) => `${e} ${found[e].size}`).join(" · ") + "     "
      );
      if (i % 20 === 0) saveSuggestCache(cache);
    }
  }
  process.stdout.write("\r" + " ".repeat(90) + "\r");

  // --- union across engines: who named whom
  const union = new Map();
  ENGINES.forEach((eng) => {
    found[eng].forEach((v, nk) => {
      const u = union.get(nk) || { name: v.name, engines: [], score: 0, via: [] };
      u.engines.push(eng);
      u.score += v.score;
      v.via.forEach((n) => { if (u.via.length < 3 && u.via.indexOf(n) === -1) u.via.push(n); });
      union.set(nk, u);
    });
  });

  const shape = (u) => ({
    name: u.name,
    engines: u.engines.slice().sort(),
    agreement: u.engines.length,
    via: u.via,
    score: r(u.score, 3),
  });
  const byScore = (a, b) => b.score - a.score || a.name.localeCompare(b.name);

  // Consensus picks: every engine independently named these.
  const consensus = [...union.values()]
    .filter((u) => u.engines.length === 3)
    .map(shape).sort(byScore).slice(0, CONSENSUS_MAX);

  // And the opposite — each engine's strongest pick that NO other engine made.
  // A list of only-consensus results would hide exactly what this section is
  // about, so both halves get shown.
  const soloByEngine = {};
  ENGINES.forEach((eng) => {
    soloByEngine[eng] = [...union.values()]
      .filter((u) => u.engines.length === 1 && u.engines[0] === eng)
      .map(shape).sort(byScore).slice(0, SOLO_PER_ENGINE);
  });

  const discovery = consensus;

  // --- how the engines compare
  const sets = {};
  ENGINES.forEach((e) => (sets[e] = new Set(found[e].keys())));
  const engines = {};
  ENGINES.forEach((e) => {
    const others = ENGINES.filter((o) => o !== e);
    let uniq = 0;
    sets[e].forEach((k) => { if (!others.some((o) => sets[o].has(k))) uniq++; });
    engines[e] = { suggested: sets[e].size, uniqueToIt: uniq };
  });

  const overlap = [];
  for (let i = 0; i < ENGINES.length; i++) {
    for (let j = i + 1; j < ENGINES.length; j++) {
      const a = sets[ENGINES[i]], b = sets[ENGINES[j]];
      let inter = 0;
      a.forEach((k) => { if (b.has(k)) inter++; });
      const unionSize = a.size + b.size - inter;
      overlap.push({
        a: ENGINES[i], b: ENGINES[j], shared: inter,
        jaccard: unionSize > 0 ? r(inter / unionSize, 4) : null,
      });
    }
  }
  let allThree = 0;
  union.forEach((u) => { if (u.engines.length === 3) allThree++; });

  // --- per-genre suggestions for the detail panel (popularity, not personalised)
  const genreSuggestions = {};
  for (let i = 0; i < genres.length; i++) {
    const g = genres[i];
    let top = cache.tags[g];
    if (!top) {
      try { top = await lastfmTagTopArtists(env, g); } catch (e) { top = []; }
      cache.tags[g] = top;
    }
    const fresh = top.filter((n) => !known.has(normName(n))).slice(0, SUGGESTIONS_PER_GENRE);
    if (fresh.length) genreSuggestions[g] = fresh;
    if (i % 25 === 0) process.stdout.write(`\r  discovery… genre ${i + 1}/${genres.length}     `);
  }
  process.stdout.write("\r" + " ".repeat(60) + "\r");

  saveSuggestCache(cache);
  return {
    discovery, soloByEngine, genreSuggestions, engines, overlap,
    totalCandidates: union.size, allThree, seeded: seeds.length,
  };
}

async function musicbrainzTags(name) {
  // MusicBrainz is a hard 1 req/sec and requires an identifying User-Agent.
  const headers = { "User-Agent": MB_USER_AGENT, Accept: "application/json" };
  const searchUrl =
    "https://musicbrainz.org/ws/2/artist?fmt=json&limit=1&query=" +
    encodeURIComponent(`artist:"${name}"`);
  let res = await paced(1100, () => fetch(searchUrl, { headers, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) }));
  stats.mbRequests++;
  if (!res.ok) return null;
  const found = await res.json();
  const hit = found && found.artists && found.artists[0];
  if (!hit || !hit.id) return null;
  // Only trust a confident name match — MB search is fuzzy and will happily
  // return something unrelated rather than nothing.
  if (Number(hit.score) < 90) return null;

  const lookupUrl = `https://musicbrainz.org/ws/2/artist/${hit.id}?fmt=json&inc=genres+tags`;
  res = await paced(1100, () => fetch(lookupUrl, { headers, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) }));
  stats.mbRequests++;
  if (!res.ok) return null;
  const a = await res.json();
  // MB's curated `genres` field is much cleaner than its crowd `tags`, which
  // leak nationality noise ("american", "américain"). Only fall back to tags
  // when an artist has no curated genres at all.
  const curated = (a.genres || []).map((g) => g && g.name).filter(Boolean);
  if (curated.length) return cleanTags(curated);
  const tags = (a.tags || [])
    .filter((t) => Number(t && t.count) > 0)
    .map((t) => t && t.name)
    .filter(Boolean);
  return cleanTags(tags);
}

async function resolveGenres(env, ids, names, index) {
  // A Spotify id is 22 base62 chars; screen malformed ones out.
  const valid = [...new Set(ids)].filter((id) => /^[A-Za-z0-9]{22}$/.test(id));
  const rejected = new Set(ids).size - valid.length;
  if (rejected) stats.warnings.push(`${rejected} artist id(s) were malformed and skipped`);
  const need = valid.filter((id) => !index.has(id) && names.get(id)).sort();

  if (!need.length) return index;

  const useLastfm = !!env.lastfmKey;
  const started = Date.now();

  if (useLastfm) {
    console.log(
      `  resolving genres for ${need.length} artist(s) via Last.fm` +
        `${MB_FALLBACK ? " (MusicBrainz fallback)" : ""} — cached after this run`
    );
  } else {
    // MusicBrainz is a hard 1 req/sec and needs 2 calls per artist.
    const mins = Math.ceil((need.length * 2.2) / 60);
    console.log(
      `  resolving genres for ${need.length} artist(s) via MusicBrainz only ` +
        `(no LASTFM_API_KEY set)`
    );
    console.log(
      `  MusicBrainz is rate-limited to 1 req/sec, so expect roughly ${mins} minute(s). ` +
        `It checkpoints every 100 artists, so Ctrl-C is safe and resumable.`
    );
  }

  for (let i = 0; i < need.length; i++) {
    const id = need[i];
    const name = names.get(id);
    let genres = null;
    let source = "none";

    if (useLastfm) {
      try {
        genres = await lastfmTags(env, name);
        if (genres && genres.length) source = "lastfm";
      } catch (e) {
        /* network hiccup — fall through to the fallback */
      }
    }

    if (MB_FALLBACK && (!genres || !genres.length)) {
      try {
        const mb = await musicbrainzTags(name);
        if (mb && mb.length) {
          genres = mb;
          source = "musicbrainz";
          stats.mbResolved++;
        }
      } catch (e) {
        /* leave it unclassified rather than fail the run */
      }
    }

    index.set(id, { name, genres: genres || [], source });
    if (source === "lastfm") stats.lastfmResolved++;
    if (source === "none") stats.unresolved++;

    if (i % 10 === 0 || i === need.length - 1) {
      const done = i + 1;
      const rate = done / ((Date.now() - started) / 1000);
      const eta = rate > 0 ? Math.round((need.length - done) / rate) : 0;
      process.stdout.write(
        `\r  genres… ${done}/${need.length}  ` +
          `${stats.lastfmResolved} last.fm · ${stats.mbResolved} musicbrainz · ${stats.unresolved} none` +
          (eta > 0 ? `  ~${Math.floor(eta / 60)}m${String(eta % 60).padStart(2, "0")}s left` : "") +
          "     "
      );
    }
    if (i > 0 && i % 100 === 0) saveArtistCache(index); // checkpoint
  }
  process.stdout.write("\r" + " ".repeat(100) + "\r");
  saveArtistCache(index);
  return index;
}

// ---------- taxonomy ----------------------------------------------------

// Applied BEFORE punctuation stripping, because & and - carry meaning here.
const ALIASES = [
  [/\br\s*&\s*b\b/g, "rnb"],
  [/\brhythm\s*(and|&)\s*blues\b/g, "rhythm and blues"],
  [/\bd\s*&\s*b\b/g, "drum and bass"],
  [/\bdnb\b/g, "drum and bass"],
  [/\bdrum\s*n\s*bass\b/g, "drum and bass"],
  [/\bdrum\s*&\s*bass\b/g, "drum and bass"],
  [/\brock\s*&\s*roll\b/g, "rock and roll"],
  [/\bhip[\s-]?hop\b/g, "hip hop"],
  [/\btrip[\s-]?hop\b/g, "trip hop"],
  [/\blo[\s-]?fi\b/g, "lo fi"],
  [/\bpost[\s-]?punk\b/g, "post punk"],
  [/\bnu[\s-]?disco\b/g, "nu disco"],
  [/\bsynth[\s-]?pop\b/g, "synth pop"],
  [/\bk[\s-]?pop\b/g, "k pop"],
  [/\bj[\s-]?pop\b/g, "j pop"],
  [/\bc[\s-]?pop\b/g, "c pop"],
];

function normalizeGenre(raw) {
  let s = String(raw || "").toLowerCase();
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // musica mexicana, reggaeton
  for (const [re, to] of ALIASES) s = s.replace(re, to);
  return s.replace(/[^a-z0-9]+/g, " ").trim();
}

// Editorial calls live here, checked first, exact-match on the normalized string.
const OVERRIDES = {
  "escape room": "Electronic",
  "vapor twitch": "Electronic",
  "witch house": "Electronic",
  wonky: "Electronic",
  nightrun: "Electronic",
  "float house": "Electronic",
  chillhop: "Electronic",
  "lo fi beats": "Electronic",
  indietronica: "Electronic",
  folktronica: "Electronic", // would otherwise hit the folk* stem
  "vapor soul": "Electronic",
  "dark wave": "Electronic",
  "stomp and holler": "Folk / Country",
  "chamber psych": "Rock",
  bubblegrunge: "Rock",
  "permanent wave": "Rock",
  "crank wave": "Rock",
  // Both decided from the artists in the library that carry the bare tag.
  // "hardcore": 27 artists, ~20 punk-ish co-tags vs ~12 electronic (Dead
  // Kennedys, Turnstile, Champion). Compound forms — hardcore techno, happy
  // hardcore, speedcore, gabber — still resolve to Electronic on their own.
  hardcore: "Punk",
  // The rave-side compounds must be named explicitly, or they inherit Punk.
  // ("hardcore techno" already resolves via Electronic's `techno` token.)
  "happy hardcore": "Electronic",
  "uk hardcore": "Electronic",
  "hardcore breaks": "Electronic",
  rave: "Electronic",
  club: "Electronic",
  digicore: "Electronic",
  "neo psychedelia": "Rock",
  psychedelia: "Rock",
  slowcore: "Rock",
  // "garage": 12 artists split 6/6, tags favour Electronic 12-9, and the
  // library is thick with uk garage / future garage / bassline elsewhere.
  // "garage rock" and "garage punk" are matched as compounds before this.
  garage: "Electronic",
  twee: "Rock",
  coldwave: "Rock",
  fusion: "Jazz",
  romantic: "Classical",
  neoclassical: "Classical",
  "dungeon synth": "Ambient / Experimental",
  slowstep: "Electronic",
  "deconstructed club": "Electronic",
  "big beat": "Electronic",
  "dirty south": "Hip Hop",
  turntablism: "Hip Hop",
  noisecore: "Metal",
  dsbm: "Metal",
  "clube da esquina": "Latin",
  "modern rock": "Rock",
  "new wave": "Rock",
  "grave wave": "Rock",
  "dream pop": "Rock",
  "shiver pop": "Pop",
  "neo mellow": "Pop",
  otacore: "Pop", // would otherwise hit a *core stem
  "alt z": "Pop",
  hyperpop: "Pop",
  "post teen pop": "Pop",
  "no wave": "Ambient / Experimental",
  fluxwork: "Ambient / Experimental",
  hauntology: "Ambient / Experimental",
  // The Reich/Glass tradition. Exact-match only — a bare "minimalism" token in
  // the rule table would swallow "minimal techno".
  minimalism: "Classical",
  piano: "Classical",
  corrosion: "Metal",
  afrofuturism: "Global",
};

// Tier 1 — compound disambiguators. `all` is order-independent, so "folk punk"
// and "punk folk" both resolve the same way. These MUST precede the tier-2 stems.
const COMPOUND_RULES = [
  ["Punk", [["folk", "punk"], ["country", "punk"], ["ska", "punk"], ["pop", "punk"], ["jazz", "punk"], ["garage", "punk"]]],
  ["Metal", [["folk", "metal"], ["punk", "metal"], ["funk", "metal"], ["rap", "metal"]]],
  ["Hip Hop", [["jazz", "rap"], ["jazz", "hip hop"], ["country", "rap"], ["soul", "rap"], ["emo", "rap"], ["g", "funk"]]],
  ["Rock", [["rap", "rock"], ["folk", "rock"], ["country", "rock"], ["blues", "rock"], ["jazz", "rock"], ["garage", "rock"], ["piano", "rock"], ["post", "rock"]]],
  ["Electronic", [["jazz", "house"], ["soul", "house"], ["electro", "swing"], ["dub", "techno"], ["piano", "house"]]],
  ["Jazz", [["jazz", "funk"], ["jazz", "fusion"], ["jazz", "blues"], ["ethio", "jazz"], ["afro", "jazz"], ["latin", "jazz"]]],
  ["R&B / Soul", [["rhythm", "blues"]]],
  ["Latin", [["latin", "trap"], ["trap", "latino"]]],
  ["Global", [["funk", "carioca"], ["brazilian", "funk"]]],
  ["Classical", [["indian", "classical"], ["classical", "crossover"]]],
  ["Reggae / Caribbean", [["reggae", "rock"], ["reggae", "fusion"]]],
  ["Folk / Country", [["bluegrass", "gospel"]]],
  ["Pop", [["acoustic", "pop"], ["chamber", "pop"], ["baroque", "pop"]]],
];

// Tier 2 — single tokens and stems. Order matters: the more promiscuous the
// token, the later the rule. Rock and Pop are last because "rock" and "pop"
// appear inside dozens of other families' genre names.
const TOKEN_RULES = [
  ["Metal", ["metal*", "doom", "thrash", "grindcore", "deathcore", "metalcore", "djent", "sludge", "blackgaze"]],
  ["Punk", ["punk*", "hardcore punk", "post hardcore", "emo", "screamo", "riot grrrl", "oi", "crust", "d beat", "skate punk", "straight edge", "anarcho"]],
  ["Hip Hop", ["hip hop", "rap", "trap", "drill", "grime", "boom bap", "crunk", "hyphy", "phonk", "horrorcore", "cloud rap"]],
  ["Electronic", ["house", "techno", "trance", "dubstep", "drum and bass", "edm", "electro*", "electronic*", "idm", "breakbeat", "jungle", "downtempo", "big room", "future bass", "hardstyle", "gabber", "uk garage", "bassline", "trip hop", "chiptune", "vaporwave", "synthwave", "chillwave", "darkwave", "synth pop", "nu disco", "glitch", "lo fi",
    // Bare Last.fm tags that are unambiguously electronic in practice.
    "future garage", "minimal", "dance", "breaks", "beats", "bass music",
    "deep house", "tech house", "acid", "ambient techno", "leftfield",
    "glo fi", "new rave", "bassline house", "uk bass", "wonky"]],
  ["Reggae / Caribbean", ["reggae", "ska", "dub", "dancehall", "rocksteady", "soca", "calypso", "mento", "dembow"]],
  ["Jazz", ["jazz*", "bebop", "hard bop", "cool jazz", "free jazz", "swing", "big band", "dixieland", "ragtime"]],
  ["Blues", ["blues", "delta blues", "chicago blues", "boogie woogie", "jump blues", "hill country blues"]],
  ["Classical", ["classical", "baroque", "opera", "orchestra*", "symphon*", "choral", "chamber music", "early music", "renaissance", "gregorian chant", "solo piano", "string quartet", "sonata", "concerto", "lieder", "art song", "soundtrack", "film score", "video game music", "epic music"]],
  ["Latin", ["latin", "reggaeton", "salsa", "bachata", "cumbia", "merengue", "banda", "corrido*", "ranchera", "mariachi", "norteno", "regional mexican", "musica mexicana", "bolero", "perreo", "vallenato", "samba", "bossa nova", "mpb", "tango", "flamenco", "sertanejo", "sierreno", "tumbado*"]],
  ["Global", ["world", "afro*", "african", "amapiano", "highlife", "soukous", "mbalax", "bhangra", "bollywood", "filmi", "carnatic", "hindustani", "desi", "arabic", "rai", "turkish", "fado", "klezmer", "qawwali", "throat singing", "gamelan", "mande", "celtic"]],
  ["Folk / Country", ["folk*", "country", "bluegrass", "americana", "alt country", "outlaw country", "singer songwriter", "appalachian", "old time", "honky tonk", "western", "cowboy", "nashville", "banjo", "fiddle", "sea shanty", "roots"]],
  ["R&B / Soul", ["rnb", "soul", "neo soul", "motown", "funk", "quiet storm", "new jack swing", "gospel", "doo wop", "southern soul", "disco"]],
  ["Ambient / Experimental", ["ambient", "drone", "noise", "field recording", "musique concrete", "experimental", "avant garde", "sound art", "dark ambient", "new age", "meditation", "binaural", "space music", "lowercase"]],
  ["Rock", ["rock*", "indie", "alternative", "grunge", "britpop", "shoegaze", "psychedelic", "surf", "prog", "jam band", "stoner", "math rock", "noise rock", "art rock", "glam", "mod", "power pop", "college rock", "heartland rock", "yacht rock"]],
  ["Pop", ["pop*", "k pop", "j pop", "c pop", "boy band", "girl group", "teen pop", "dance pop", "europop", "bubblegum", "eurovision", "adult standards", "easy listening", "lounge", "chanson", "schlager", "city pop"]],
];

// Flattened, ordered: compounds first, then token stems.
const RULES = [];
for (const [family, combos] of COMPOUND_RULES) {
  for (const all of combos) RULES.push({ family, all });
}
for (const [family, any] of TOKEN_RULES) RULES.push({ family, any });

function matchPattern(pattern, padded, toks) {
  if (pattern.endsWith("*")) {
    const stem = pattern.slice(0, -1);
    return toks.some((t) => t.startsWith(stem));
  }
  // Whole word-sequence match. Plain includes() would make "rock" match
  // "rocksteady", "dub" match "dubstep", and "*core" match "otacore".
  return padded.includes(" " + pattern + " ");
}

const classifyCache = new Map();

function classifyGenre(raw) {
  const norm = normalizeGenre(raw);
  if (classifyCache.has(norm)) return classifyCache.get(norm);

  let result;
  if (!norm) {
    result = { norm, family: FAMILY_OTHER, ruleIndex: -1, via: "unmatched" };
  } else if (OVERRIDES[norm]) {
    result = { norm, family: OVERRIDES[norm], ruleIndex: -1, via: "override" };
  } else {
    const padded = " " + norm + " ";
    const toks = norm.split(" ");
    let hit = null;
    for (let i = 0; i < RULES.length; i++) {
      const rule = RULES[i];
      if (rule.not && rule.not.some((p) => matchPattern(p, padded, toks))) continue;
      if (rule.all && !rule.all.every((p) => matchPattern(p, padded, toks))) continue;
      if (rule.any && !rule.any.some((p) => matchPattern(p, padded, toks))) continue;
      hit = { norm, family: rule.family, ruleIndex: i, via: "rule" };
      break;
    }
    result = hit || { norm, family: FAMILY_OTHER, ruleIndex: -1, via: "unmatched" };
  }
  classifyCache.set(norm, result);
  return result;
}

// ---------- taxonomy selftest -------------------------------------------

const FIXTURES = [
  ["folk punk", "Punk"],
  ["punk folk", "Punk"],
  ["pop punk", "Punk"],
  ["folk metal", "Metal"],
  ["rap metal", "Metal"],
  ["rap rock", "Rock"],
  ["folk rock", "Rock"],
  ["jazz rap", "Hip Hop"],
  ["otacore", "Pop"],
  ["metalcore", "Metal"],
  ["rocksteady", "Reggae / Caribbean"],
  ["roots reggae", "Reggae / Caribbean"],
  ["dubstep", "Electronic"],
  ["dub techno", "Electronic"],
  ["dub", "Reggae / Caribbean"],
  ["rhythm and blues", "R&B / Soul"],
  ["r&b", "R&B / Soul"],
  ["delta blues", "Blues"],
  ["latin jazz", "Jazz"],
  ["jazz fusion", "Jazz"],
  ["electro swing", "Electronic"],
  ["piano house", "Electronic"],
  ["bluegrass gospel", "Folk / Country"],
  ["gospel", "R&B / Soul"],
  ["folktronica", "Electronic"],
  ["indietronica", "Electronic"],
  ["escape room", "Electronic"],
  ["stomp and holler", "Folk / Country"],
  ["chamber psych", "Rock"],
  ["chamber pop", "Pop"],
  ["dream pop", "Rock"],
  ["indie rock", "Rock"],
  ["new wave", "Rock"],
  ["no wave", "Ambient / Experimental"],
  ["synth pop", "Electronic"],
  ["k-pop", "Pop"],
  ["reggaeton", "Latin"],
  ["musica mexicana", "Latin"],
  ["afrobeat", "Global"],
  ["hip hop", "Hip Hop"],
  ["trip hop", "Electronic"],
  ["drum and bass", "Electronic"],
  ["dnb", "Electronic"],
  ["drum & bass", "Electronic"],
  ["música mexicana", "Latin"],
  ["reggaetón", "Latin"],
  ["rock & roll", "Rock"],
  ["soundtrack", "Classical"],
  ["solo piano", "Classical"],
  ["disco", "R&B / Soul"],
  ["nu disco", "Electronic"],
  ["singer songwriter", "Folk / Country"],
  ["dark ambient", "Ambient / Experimental"],
  ["minimalism", "Classical"],
  ["minimal techno", "Electronic"],
  ["hauntology", "Ambient / Experimental"],
  ["sad sierreño", "Latin"],
  ["afro house", "Electronic"],
  ["desert blues", "Blues"],
  ["celtic punk", "Punk"],
  ["indie folk", "Folk / Country"],
  // Bare Last.fm tags seen in the real data
  ["future garage", "Electronic"],
  ["minimal", "Electronic"],
  ["dance", "Electronic"],
  ["breaks", "Electronic"],
  ["tech house", "Electronic"],
  ["leftfield", "Electronic"],
  ["crank wave", "Rock"],
  ["glo fi", "Electronic"],
  ["new rave", "Electronic"],
  ["piano", "Classical"],
  ["solo piano", "Classical"],
  ["piano house", "Electronic"],   // must NOT fall to the bare-piano override
  ["piano rock", "Rock"],
  ["twee", "Rock"],
  ["coldwave", "Rock"],
  ["fusion", "Jazz"],
  ["jazz fusion", "Jazz"],
  ["neoclassical", "Classical"],
  ["dungeon synth", "Ambient / Experimental"],
  ["dirty south", "Hip Hop"],
  ["turntablism", "Hip Hop"],
  ["big beat", "Electronic"],
  ["dsbm", "Metal"],
  ["clube da esquina", "Latin"],
  ["hardcore", "Punk"],
  ["hardcore punk", "Punk"],
  ["hardcore techno", "Electronic"],
  ["happy hardcore", "Electronic"],
  ["post hardcore", "Punk"],
  ["garage", "Electronic"],
  ["uk garage", "Electronic"],
  ["future garage", "Electronic"],
  ["garage rock", "Rock"],
  ["garage punk", "Punk"],
  ["rave", "Electronic"],
  ["new rave", "Electronic"],
  ["digicore", "Electronic"],
  ["neo-psychedelia", "Rock"],
  ["slowcore", "Rock"],
];

// Tags that must be dropped as noise rather than classified. Verified here so a
// future stoplist edit can't silently let "british" back in as a genre.
const STOPLIST_FIXTURES = [
  "british", "german", "usa", "uk", "french", "canadian", "australian",
  "swedish", "chinese", "japanese", "brazilian", "american", "united kingdom",
  "los angeles", "quebec", "all", "seen live", "female vocalists", "00s",
  "guitar", "saxophone", "trumpet", "bass", "underground", "west coast",
  "united states", "brasil", "nigeria", "mali", "ethiopia", "ghana", "irish",
  "puerto rico", "south africa", "california", "jewish", "conductor", "birp",
  "malaysian", "colombia", "turkey", "lebanon", "bay area",
];

function runSelftest() {
  const failures = [];
  for (const [genre, expected] of FIXTURES) {
    const got = classifyGenre(genre).family;
    if (got !== expected) failures.push({ genre, expected, got });
  }
  // The stoplist is the other half of the taxonomy: a tag that survives it
  // becomes a fake genre in every chart.
  for (const tag of STOPLIST_FIXTURES) {
    if (cleanTags([tag]).length !== 0) {
      failures.push({ genre: tag, expected: "(dropped by stoplist)", got: "kept" });
    }
  }
  const total = FIXTURES.length + STOPLIST_FIXTURES.length;
  console.log(`Taxonomy selftest — ${total - failures.length}/${total} passed`);
  if (failures.length) {
    console.log("\nFailures:");
    failures.forEach((f) =>
      console.log(`  ${f.genre.padEnd(24)} expected ${f.expected.padEnd(22)} got ${f.got}`)
    );
    return 1;
  }
  return 0;
}

function explainGenre(genre) {
  const r = classifyGenre(genre);
  console.log(`"${genre}"`);
  console.log(`  normalized : ${r.norm}`);
  console.log(`  family     : ${r.family}`);
  console.log(`  via        : ${r.via}`);
  if (r.ruleIndex >= 0) {
    const rule = RULES[r.ruleIndex];
    console.log(`  rule #${r.ruleIndex}   : ${JSON.stringify(rule)}`);
  }
}

// ---------- weighting ---------------------------------------------------
//
// An artist with 4 genres gives each 0.25, not 1.0, so every track contributes
// exactly 1.0 of mass. Whole-counting would measure Spotify's tagging verbosity
// rather than listening diversity, and would inflate effectiveGenres.
//
//   weight — fractional. The ONLY thing any metric consumes.
//   tracks — integer, +1 per track that touched the genre at all. Display only.
//            It intentionally sums to more than `items`.

// The stoplist must be applied where genres are USED, not only where they're
// fetched — otherwise editing it does nothing until the whole artist cache is
// rebuilt, and stale nationality tags keep showing up in the charts. Raw tags
// stay in the cache; the memo is per-entry and never serialized.
function artistGenres(a) {
  if (!a) return [];
  if (!a._clean) a._clean = cleanTags(a.genres || []);
  return a._clean;
}

function newBag(unit) {
  return { unit, w: new Map(), t: new Map(), mass: 0, items: 0, artistIds: new Set() };
}

function bump(map, key, amount) {
  map.set(key, (map.get(key) || 0) + amount);
}

function addTrack(bag, track, artistIndex) {
  const share = 1 / track.artistIds.length;
  const touched = new Set();
  for (const aid of track.artistIds) {
    bag.artistIds.add(aid);
    const artist = artistIndex.get(aid);
    const genres = artistGenres(artist);
    if (!genres.length) {
      bump(bag.w, UNCLASSIFIED, share);
      touched.add(UNCLASSIFIED);
    } else {
      const per = share / genres.length;
      for (const g of genres) {
        bump(bag.w, g, per);
        touched.add(g);
      }
    }
  }
  touched.forEach((g) => bump(bag.t, g, 1));
  bag.mass += 1;
  bag.items += 1;
}

function addArtist(bag, artist) {
  if (!artist) return;
  bag.artistIds.add(artist.id);
  const genres = artistGenres(artist);
  if (!genres.length) {
    bump(bag.w, UNCLASSIFIED, 1);
    bump(bag.t, UNCLASSIFIED, 1);
  } else {
    const per = 1 / genres.length;
    for (const g of genres) {
      bump(bag.w, g, per);
      bump(bag.t, g, 1);
    }
  }
  bag.mass += 1;
  bag.items += 1;
}

function mergeBags(unit, bags) {
  const out = newBag(unit);
  for (const b of bags) {
    if (!b) continue;
    b.w.forEach((v, k) => bump(out.w, k, v));
    b.t.forEach((v, k) => bump(out.t, k, v));
    b.artistIds.forEach((id) => out.artistIds.add(id));
    out.mass += b.mass;
    out.items += b.items;
  }
  return out;
}

function assertMass(bag, label) {
  let sum = 0;
  bag.w.forEach((v) => (sum += v));
  if (Math.abs(bag.mass - sum) > 1e-6) {
    throw new Error(
      `mass invariant violated in "${label}": mass ${bag.mass} vs Σweights ${sum}`
    );
  }
}

// ---------- metrics -----------------------------------------------------

function shannon(ps) {
  let h = 0;
  for (const p of ps) if (p > 0) h -= p * Math.log(p);
  return h;
}

function gini(ws) {
  const xs = ws.slice().sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return null;
  if (n === 1) return 0;
  const total = xs.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += (i + 1) * xs[i];
  return (2 * acc) / (n * total) - (n + 1) / n;
}

function lorenz(ws, k = 21) {
  const xs = ws.slice().sort((a, b) => a - b);
  const n = xs.length;
  const total = xs.reduce((a, b) => a + b, 0);
  if (!n || total <= 0) return [];
  const cum = [];
  let running = 0;
  for (const x of xs) {
    running += x;
    cum.push(running / total);
  }
  const pts = [];
  for (let i = 0; i < k; i++) {
    const x = i / (k - 1);
    const idx = Math.max(0, Math.ceil(x * n) - 1);
    pts.push({ x: r(x, 4), y: r(i === 0 ? 0 : cum[idx], 4) });
  }
  return pts;
}

function computeMetrics(weights) {
  const ws = [...weights.values()].filter((w) => w > 0);
  const total = ws.reduce((a, b) => a + b, 0);
  const S = ws.length;
  if (!S || total <= 0) {
    return {
      S: 0, shannonH: null, effectiveGenres: null, evenness: null,
      simpsonD: null, giniSimpson: null, inverseSimpson: null,
      top3Share: null, top10Share: null, gini: null, lorenz: [],
    };
  }
  const ps = ws.map((w) => w / total);
  const H = shannon(ps);
  const D = ps.reduce((a, p) => a + p * p, 0);
  const sorted = ps.slice().sort((a, b) => b - a);
  const topN = (n) => sorted.slice(0, n).reduce((a, b) => a + b, 0);
  return {
    S,
    shannonH: r(H, 4),
    effectiveGenres: r(Math.exp(H), 4),
    evenness: S > 1 ? r(H / Math.log(S), 4) : null,
    simpsonD: r(D, 4),
    giniSimpson: r(1 - D, 4),
    inverseSimpson: D > 0 ? r(1 / D, 4) : null,
    top3Share: r(topN(3), 4),
    top10Share: r(topN(10), 4),
    gini: r(gini(ws), 4),
    lorenz: lorenz(ws),
  };
}

// ---------- assembly ----------------------------------------------------

function r(n, dp) {
  if (n === null || n === undefined) return null;
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function splitBag(bag) {
  // Three disjoint pools:
  //   unclassified — artist returned genres: []. Spotify has no data.
  //   unmatched    — a real genre that hit no rule. OUR table's gap.
  //   classified   — matched a rule or an override.
  // Conflating the first two makes a taxonomy gap look like a Spotify gap.
  const genreW = new Map();
  const familyW = new Map();
  let unclassifiedMass = 0;
  let unmatchedMass = 0;

  bag.w.forEach((w, g) => {
    if (g === UNCLASSIFIED) {
      unclassifiedMass += w;
      return;
    }
    genreW.set(g, w);
    const c = classifyGenre(g);
    if (c.via === "unmatched") unmatchedMass += w;
    bump(familyW, c.family, w);
  });

  const familyReal = new Map();
  familyW.forEach((w, f) => {
    if (f !== FAMILY_OTHER && f !== FAMILY_UNCLASSIFIED) familyReal.set(f, w);
  });

  return { genreW, familyW, familyReal, unclassifiedMass, unmatchedMass };
}

function buildSourceBlock(bag, extra) {
  const { genreW, familyW, familyReal, unclassifiedMass, unmatchedMass } = splitBag(bag);
  const total = bag.mass || 0;
  let classifiedMass = 0;
  genreW.forEach((w) => (classifiedMass += w));
  classifiedMass -= unmatchedMass;

  const genreEntries = [...genreW.entries()].map(([name, weight]) => ({
    name,
    weight: r(weight, 3),
    tracks: bag.t.get(name) || 0,
    family: classifyGenre(name).family,
    share: total > 0 ? r(weight / total, 4) : null,
  }));

  // Select the top N by weight, but EMIT sorted by name so diffs stay stable.
  const kept = genreEntries
    .slice()
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
    .slice(0, TOP_GENRES_PER_BLOCK)
    .sort((a, b) => a.name.localeCompare(b.name));

  const familyDistribution = [...familyW.entries()]
    .map(([family, weight]) => ({
      family,
      weight: r(weight, 3),
      share: total > 0 ? r(weight / total, 4) : null,
    }))
    .sort((a, b) => a.family.localeCompare(b.family));

  return {
    ok: true,
    unit: bag.unit,
    window: null,
    items: bag.items,
    artists: bag.artistIds.size,
    mass: r(total, 3),
    coverage: {
      classifiedMass: r(classifiedMass, 3),
      unmatchedMass: r(unmatchedMass, 3),
      unclassifiedMass: r(unclassifiedMass, 3),
      classifiedShare: total > 0 ? r(classifiedMass / total, 4) : null,
      unmatchedShare: total > 0 ? r(unmatchedMass / total, 4) : null,
      unclassifiedShare: total > 0 ? r(unclassifiedMass / total, 4) : null,
    },
    genres: kept,
    genresTotal: genreEntries.length,
    genresTruncated: genreEntries.length > TOP_GENRES_PER_BLOCK,
    familyDistribution,
    metrics: {
      basis: "classified",
      genre: computeMetrics(genreW),
      macro: computeMetrics(familyReal),
    },
    extra: extra || {},
  };
}

function emptySourceBlock(unit, reason) {
  return {
    ok: false, unit, window: null, items: 0, artists: 0, mass: 0,
    coverage: { classifiedMass: 0, unmatchedMass: 0, unclassifiedMass: 0,
      classifiedShare: null, unmatchedShare: null, unclassifiedShare: null },
    genres: [], genresTotal: 0, genresTruncated: false, familyDistribution: [],
    metrics: { basis: "classified", genre: computeMetrics(new Map()), macro: computeMetrics(new Map()) },
    extra: { reason: reason || "unavailable" },
  };
}

// ---------- co-occurrence graph -----------------------------------------

function buildGraph(artistIndex, artistMass) {
  const nodeArtists = new Map();
  const nodeWeight = new Map();
  const edges = new Map();

  artistIndex.forEach((artist, id) => {
    const genres = artistGenres(artist);
    if (!genres.length) return;
    const mass = artistMass.get(id) || 0;
    for (const g of genres) {
      bump(nodeArtists, g, 1);
      bump(nodeWeight, g, mass);
    }
    if (genres.length < 2) return;
    const sorted = genres.slice().sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = sorted[i] + "\u0000" + sorted[j];
        const e = edges.get(key) || { artists: 0, weight: 0 };
        e.artists += 1;
        e.weight += mass;
        edges.set(key, e);
      }
    }
  });

  const totalEdgeWeight = [...edges.values()].reduce((a, e) => a + e.weight, 0);

  const keptNodes = new Set(
    [...nodeArtists.entries()].filter(([, n]) => n >= MIN_GENRE_ARTISTS).map(([g]) => g)
  );
  const droppedGenres = nodeArtists.size - keptNodes.size;

  let candidates = [...edges.entries()]
    .map(([key, e]) => {
      const [source, target] = key.split("\u0000");
      return { source, target, artists: e.artists, weight: e.weight };
    })
    .filter(
      (e) => e.artists >= MIN_EDGE_ARTISTS && keptNodes.has(e.source) && keptNodes.has(e.target)
    );

  const droppedEdges = edges.size - candidates.length;

  candidates.sort(
    (a, b) =>
      b.weight - a.weight ||
      a.source.localeCompare(b.source) ||
      a.target.localeCompare(b.target)
  );
  const links = candidates.slice(0, MAX_EDGES);
  const keptWeight = links.reduce((a, e) => a + e.weight, 0);

  const connected = new Set();
  links.forEach((e) => {
    connected.add(e.source);
    connected.add(e.target);
  });

  const degree = new Map();
  links.forEach((e) => {
    bump(degree, e.source, 1);
    bump(degree, e.target, 1);
  });

  const nodes = [...connected]
    .map((g) => ({
      id: g,
      family: classifyGenre(g).family,
      artists: nodeArtists.get(g) || 0,
      weight: r(nodeWeight.get(g) || 0, 3),
      degree: degree.get(g) || 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  // Family-level rollup: <=105 edges, gives the page a legible overview mode.
  const famEdges = new Map();
  links.forEach((e) => {
    const fa = classifyGenre(e.source).family;
    const fb = classifyGenre(e.target).family;
    if (fa === fb) return;
    const key = fa < fb ? fa + "\u0000" + fb : fb + "\u0000" + fa;
    const acc = famEdges.get(key) || { artists: 0, weight: 0 };
    acc.artists += e.artists;
    acc.weight += e.weight;
    famEdges.set(key, acc);
  });

  const familyLinks = [...famEdges.entries()]
    .map(([key, v]) => {
      const [source, target] = key.split("\u0000");
      return { source, target, artists: v.artists, weight: r(v.weight, 3) };
    })
    .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));

  return {
    nodes,
    links: links
      .map((e) => ({
        source: e.source,
        target: e.target,
        artists: e.artists,
        weight: r(e.weight, 3),
      }))
      .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)),
    familyLinks,
    pruning: {
      minGenreArtists: MIN_GENRE_ARTISTS,
      minEdgeArtists: MIN_EDGE_ARTISTS,
      maxEdges: MAX_EDGES,
      droppedGenres,
      droppedEdges,
      keptShareOfWeight: totalEdgeWeight > 0 ? r(keptWeight / totalEdgeWeight, 4) : null,
    },
  };
}

// ---------- taxonomy report ---------------------------------------------

function buildTaxonomyReport(combinedBag) {
  const unmatched = [];
  const overridesUsed = new Set();
  const familyCounts = {};
  let unmatchedMass = 0;
  let total = 0;

  combinedBag.w.forEach((w, g) => {
    if (g === UNCLASSIFIED) return;
    total += w;
    const c = classifyGenre(g);
    familyCounts[c.family] = (familyCounts[c.family] || 0) + 1;
    if (c.via === "override") overridesUsed.add(c.norm);
    if (c.via === "unmatched") {
      unmatchedMass += w;
      unmatched.push({ genre: g, artists: combinedBag.t.get(g) || 0, weight: r(w, 3) });
    }
  });

  const truncated = unmatched.length > MAX_UNMATCHED_LISTED;
  const kept = unmatched
    .slice()
    .sort((a, b) => b.weight - a.weight || a.genre.localeCompare(b.genre))
    .slice(0, MAX_UNMATCHED_LISTED)
    .sort((a, b) => a.genre.localeCompare(b.genre));

  return {
    unmatched: kept,
    unmatchedCount: unmatched.length,
    unmatchedShare: total > 0 ? r(unmatchedMass / total, 4) : null,
    unmatchedTruncated: truncated,
    overridesUsed: [...overridesUsed].sort(),
    familyCounts: sortedObject(familyCounts),
  };
}

function sortedObject(obj) {
  const out = {};
  Object.keys(obj)
    .sort()
    .forEach((k) => (out[k] = obj[k]));
  return out;
}

// ---------- main --------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^#![^\n]*\n/, ""));
    return 0;
  }
  if (opts.selftest) return runSelftest();
  if (opts.explain) {
    explainGenre(opts.explain);
    return 0;
  }

  // Fixtures are cheap; never build against a broken rule table.
  if (runSelftest() !== 0) {
    console.error("\nRefusing to build with failing taxonomy fixtures.");
    return 1;
  }
  console.log("");

  const env = requireEnv();
  const fetchOpts = { cache: opts.cache, cacheOnly: opts.cacheOnly };
  if (opts.cacheOnly) {
    console.log("  --cache-only: no Spotify requests; genre lookups still run\n");
  }
  const started = Date.now();

  // Both of these are live Spotify calls, so they must be skipped entirely in
  // cache-only mode — otherwise the scope preflight is what trips the 429 and
  // the run dies before reaching a single cached response.
  if (!opts.cacheOnly) {
    await ensureToken(env, true);
    await preflightScopes(env, fetchOpts);
  }

  const me = await fetchMe(env, fetchOpts);
  console.log(`Signed in as ${me.displayName || "(no display name)"} (${me.country || "??"})`);

  // ---- collect raw tracks/artists per source
  const saved = await fetchSavedTracks(env, { ...fetchOpts, limit: opts.limit });
  console.log(`  saved tracks       ${saved.length}`);

  let playlists = [];
  const playlistData = [];
  if (opts.playlists) {
    playlists = await fetchPlaylists(env, me.id, fetchOpts);
    for (let i = 0; i < playlists.length; i++) {
      const pl = playlists[i];
      const res = await fetchPlaylistItems(env, pl, fetchOpts);
      playlistData.push({ meta: pl, ...res });
      process.stdout.write(`\r  playlists… ${i + 1}/${playlists.length}`);
    }
    if (playlists.length) process.stdout.write("\r");
    const plTracks = playlistData.reduce((n, p) => n + p.tracks.length, 0);
    const plReadable = playlistData.filter((p) => !p.skipped).length;
    console.log(`  playlists          ${playlists.length} (${plTracks} tracks)`.padEnd(30));
    // Readable playlists yielding zero tracks means the item shape changed
    // again and the unwrap fell through — that produced empty charts once.
    if (opts.cacheOnly && stats.cacheMisses) {
      stats.warnings.push(
        `${stats.cacheMisses} Spotify request(s) skipped as uncached (--cache-only) — ` +
          `this build is partial`
      );
    }
    if (!opts.cacheOnly && plReadable > 0 && plTracks === 0) {
      throw new Error(
        `${plReadable} playlist(s) were readable but yielded 0 tracks — the item ` +
          `shape has changed.\n  Check warnings above for the observed keys, then ` +
          `update unwrapItem().`
      );
    }
  }

  const topWindows = ["short_term", "medium_term", "long_term"];
  const topArtistsRaw = {};
  const topTracksRaw = {};
  for (const w of topWindows) {
    topArtistsRaw[w] = await fetchTop(env, "artists", w, fetchOpts);
    topTracksRaw[w] = (await fetchTop(env, "tracks", w, fetchOpts))
      .map(normalizeTrack)
      .filter(Boolean);
  }
  const recent = await fetchRecent(env, fetchOpts);
  console.log(`  recent plays       ${recent.length}`);

  // ---- hydrate every artist id we touched
  const allArtistIds = new Set();
  saved.forEach((t) => t.artistIds.forEach((id) => allArtistIds.add(id)));
  playlistData.forEach((p) => p.tracks.forEach((t) => t.artistIds.forEach((id) => allArtistIds.add(id))));
  topWindows.forEach((w) => {
    topArtistsRaw[w].forEach((a) => a && a.id && allArtistIds.add(a.id));
    topTracksRaw[w].forEach((t) => t.artistIds.forEach((id) => allArtistIds.add(id)));
  });
  recent.forEach((t) => t.artistIds.forEach((id) => allArtistIds.add(id)));

  // /me/top/artists returns full artist objects — harvest their names too.
  topWindows.forEach((w) => {
    topArtistsRaw[w].forEach((a) => {
      if (a && a.id && a.name && !artistNames.has(a.id)) artistNames.set(a.id, a.name);
    });
  });

  const artistIndex = loadArtistCache();
  // Old cache entries predate the genre-provider switch and hold empty genres
  // from Spotify. Drop those so they get re-resolved rather than counted as
  // genuinely genre-less artists.
  // Only entries with NO `source` field predate the genre-provider switch —
  // those are the Spotify-era rows with empty genres and must be re-resolved.
  // A recorded `source: "none"` means both providers were asked and neither
  // knew the artist; re-querying those every run costs ~2s each at
  // MusicBrainz's 1 req/sec and never yields anything new.
  let stale = 0;
  [...artistIndex.entries()].forEach(([id, a]) => {
    if (!a.source) {
      artistIndex.delete(id);
      stale++;
    }
  });
  if (stale) console.log(`  dropped ${stale} stale cache entr(ies) from before the genre-source switch`);
  const cachedAtStart = artistIndex.size;

  await resolveGenres(env, [...allArtistIds], artistNames, artistIndex);
  console.log(
    `  artists            ${artistIndex.size}` +
      (cachedAtStart ? ` (${cachedAtStart} from cache)` : "")
  );

  let withGenres = 0;
  artistIndex.forEach((a) => {
    if (artistGenres(a).length) withGenres++;
  });
  if (withGenres === 0) {
    throw new Error(
      "zero artists resolved any genre — refusing to overwrite good data with an empty build.\n" +
        "  Check LASTFM_API_KEY is valid (https://www.last.fm/api/account/create)."
    );
  }

  // ---- bags
  const bagSaved = newBag("track");
  saved.forEach((t) => addTrack(bagSaved, t, artistIndex));

  const bagOwned = newBag("track");
  const bagFollowed = newBag("track");
  const playlistBlocks = [];
  playlistData
    .slice()
    .sort((a, b) => a.meta.id.localeCompare(b.meta.id))
    .forEach((p, i) => {
      const target = p.meta.owned ? bagOwned : bagFollowed;
      const own = newBag("track");
      p.tracks.forEach((t) => {
        addTrack(target, t, artistIndex);
        addTrack(own, t, artistIndex);
      });
      const { familyW } = splitBag(own);
      const topFamilies = [...familyW.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 3)
        .map(([f, w]) => [f, own.mass > 0 ? r(w / own.mass, 4) : null]);
      playlistBlocks.push({
        // Playlist NAMES are personal and this repo is public — omitted by default.
        label: opts.playlistNames === "full" ? p.meta.name : `Playlist ${i + 1}`,
        owned: p.meta.owned,
        collaborative: p.meta.collaborative,
        items: own.items,
        truncated: !!p.truncated,
        effectiveGenres: computeMetrics(own.w).effectiveGenres,
        topFamilies,
      });
    });

  const bagTopArtists = newBag("artist");
  const bagTopTracks = newBag("track");
  topWindows.forEach((w) => {
    topArtistsRaw[w].forEach((a) => a && a.id && addArtist(bagTopArtists, artistIndex.get(a.id)));
    topTracksRaw[w].forEach((t) => addTrack(bagTopTracks, t, artistIndex));
  });

  const bagRecent = newBag("play");
  recent.forEach((t) => addTrack(bagRecent, t, artistIndex));

  const bags = {
    saved: bagSaved,
    playlistsOwned: bagOwned,
    playlistsFollowed: bagFollowed,
    topArtists: bagTopArtists,
    topTracks: bagTopTracks,
    recent: bagRecent,
  };
  Object.entries(bags).forEach(([label, bag]) => assertMass(bag, label));

  const combined = mergeBags("mixed", COMBINE_SOURCES.map((k) => bags[k]));
  assertMass(combined, "combined");
  // The genres that will actually appear in the emitted table/treemap.
  const combinedTopGenres = new Set(
    [...combined.w.entries()]
      .filter(([g]) => g !== UNCLASSIFIED)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_GENRES_PER_BLOCK)
      .map(([g]) => g)
  );

  // ---- per-window detail for the taste-drift panel
  const windowsDetail = {};
  for (const w of topWindows) {
    const b = newBag("artist");
    topArtistsRaw[w].forEach((a) => a && a.id && addArtist(b, artistIndex.get(a.id)));
    const { familyW } = splitBag(b);
    windowsDetail[w] = [...familyW.entries()]
      .map(([family, weight]) => ({
        family,
        share: b.mass > 0 ? r(weight / b.mass, 4) : null,
      }))
      .sort((a, b2) => a.family.localeCompare(b2.family));
  }

  // ---- artist mass for graph node weighting
  const artistMass = new Map();
  const countArtists = (tracks) =>
    tracks.forEach((t) => {
      const share = 1 / t.artistIds.length;
      t.artistIds.forEach((id) => bump(artistMass, id, share));
    });
  countArtists(saved);
  playlistData.forEach((p) => p.meta.owned && countArtists(p.tracks));
  countArtists(recent);

  const graph = buildGraph(artistIndex, artistMass);

  // ---- example artists per genre, so a genre can be clicked to see who's in it
  const genreArtistPool = new Map();
  artistIndex.forEach((a, id) => {
    if (!a.name) return;
    const mass = artistMass.get(id) || 0;
    artistGenres(a).forEach((g) => {
      const arr = genreArtistPool.get(g) || [];
      arr.push({ name: a.name, mass });
      genreArtistPool.set(g, arr);
    });
  });
  // Only emit for genres the page can surface (table/treemap rows + graph nodes),
  // so this stays a few tens of KB rather than covering all 1,100.
  const wanted = new Set(graph.nodes.map((n) => n.id));
  const genreExamples = {};
  [...genreArtistPool.keys()].sort().forEach((g) => {
    if (!wanted.has(g) && !combinedTopGenres.has(g)) return;
    const list = genreArtistPool
      .get(g)
      .sort((x, y) => y.mass - x.mass || x.name.localeCompare(y.name))
      .slice(0, EXAMPLES_PER_GENRE)
      .map((x) => x.name);
    if (list.length) genreExamples[g] = list;
  });

  // ---- discovery: what ISN'T in the library, from Last.fm
  const discoveryGenres = [...wanted].filter((g) => combinedTopGenres.has(g)).sort().slice(0, 200);
  const disc = opts.noDiscovery
    ? { discovery: [], genreSuggestions: {}, seeded: 0 }
    : await buildDiscovery(env, artistIndex, artistMass, discoveryGenres);

  // ---- top artists list
  const topArtistList = [...artistMass.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_ARTISTS_EMITTED)
    .map(([id]) => {
      const a = artistIndex.get(id) || { name: "", genres: [] };
      return {
        name: a.name,
        genres: artistGenres(a).slice().sort(),
        families: [...new Set(artistGenres(a).map((g) => classifyGenre(g).family))].sort(),
        weight: r(artistMass.get(id), 3),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const out = {
    schemaVersion: SCHEMA_VERSION,
    rulesVersion: RULES_VERSION,
    asOf: new Date().toISOString(),
    generatedBy: "scripts/build-spotify-genres.js",
    // Where each kind of data actually came from. The page renders this — the
    // genre source is no longer Spotify and the page must not imply it is.
    provenance: {
      listening: "Spotify Web API (saved tracks, playlists, top artists/tracks, recent plays)",
      genres: "Last.fm artist.getTopTags, falling back to MusicBrainz",
      suggestions:
        "Last.fm artist.getSimilar seeded from the most-played artists, plus " +
        "tag.getTopArtists per genre. Anything already in the library is filtered out.",
      genresNote:
        "Spotify removed the artist `genres` field; its docs still list it but the live " +
        "API no longer returns it. Genre sources are matched on artist NAME, so " +
        "same-named artists can collide.",
      // Counted across the whole artist index, not just this run's lookups —
      // on a warm cache the run resolves nothing and these would all be zero.
      resolved: (function () {
        const c = { lastfm: 0, musicbrainz: 0, unresolved: 0 };
        artistIndex.forEach((a) => {
          if (a.source === "lastfm") c.lastfm++;
          else if (a.source === "musicbrainz") c.musicbrainz++;
          else c.unresolved++;
        });
        return c;
      })(),
    },
    notes: {
      history:
        "topArtists/topTracks are three API snapshots (~4 weeks / ~6 months / ~1 year), " +
        "not continuous history. recent is capped at the last 50 plays by the API.",
      weighting:
        "An artist with N genres contributes 1/N to each, so every item's weights sum to 1. " +
        "`weight` drives all metrics; `tracks` is a display-only integer and sums to more than `items`.",
      playlistNames: opts.playlistNames,
    },
    profile: { displayName: me.displayName, country: me.country },
    families: FAMILIES.slice().sort(),
    sources: {
      saved: buildSourceBlock(bagSaved, {
        libraryTotal: savedTotals.total,
        sampled: savedTotals.total != null && bagSaved.items < savedTotals.total,
      }),
      playlistsOwned: buildSourceBlock(bagOwned),
      playlistsFollowed: buildSourceBlock(bagFollowed),
      topArtists: buildSourceBlock(bagTopArtists, { windows: windowsDetail }),
      topTracks: buildSourceBlock(bagTopTracks),
      recent: buildSourceBlock(bagRecent),
    },
    combined: { ...buildSourceBlock(combined), includes: COMBINE_SOURCES.slice() },
    playlists: playlistBlocks,
    graph,
    genreExamples,
    discovery: {
      artists: disc.discovery,
      soloByEngine: disc.soloByEngine || {},
      engines: disc.engines,
      overlap: disc.overlap,
      seeds: disc.seeded,
      totalCandidates: disc.totalCandidates,
      allThree: disc.allThree,
      note:
        "Three independent recommenders, seeded from the most-played artists. " +
        "Anything already in the library is filtered out. Last.fm and ListenBrainz " +
        "are collaborative filtering over listening logs (commercial scrobbles and " +
        "open listen data); Deezer is its own streaming-behaviour model.",
    },
    genreSuggestions: disc.genreSuggestions,
    taxonomy: buildTaxonomyReport(combined),
    artists: topArtistList,
    warnings: [...new Set(stats.warnings)].sort(),
  };

  // ---- write
  if (!opts.dryRun) {
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, JSON.stringify(out, null, 2) + "\n");
  }

  // ---- summary
  const rel = path.relative(ROOT, opts.out);
  const bytes = Buffer.byteLength(JSON.stringify(out, null, 2) + "\n");
  console.log(
    `\n${opts.dryRun ? "Computed (dry run)" : `Wrote ${rel}`} — ` +
      `${Object.keys(out.sources).length} source(s), ${artistIndex.size} artist(s), ` +
      `${out.combined.genresTotal} genre(s), ${(bytes / 1024).toFixed(0)} KB:`
  );
  for (const [name, block] of Object.entries(out.sources)) {
    console.log(
      `  ${name.padEnd(20)} ${String(block.items).padStart(5)} ${block.unit.padEnd(6)}` +
        ` ${String(block.genresTotal).padStart(4)} genres` +
        `  e^H ${String(block.metrics.genre.effectiveGenres ?? "—").padStart(7)}` +
        `  gini ${String(block.metrics.genre.gini ?? "—").padStart(6)}`
    );
  }
  const cov = out.combined.coverage;
  console.log(
    `\n  unclassified (artist has no genres)  ${((cov.unclassifiedShare || 0) * 100).toFixed(1)}% of mass`
  );
  console.log(
    `  unmatched (no rule hit)              ${((cov.unmatchedShare || 0) * 100).toFixed(1)}% of mass` +
      ` — ${out.taxonomy.unmatchedCount} distinct`
  );
  if (out.taxonomy.unmatched.length) {
    console.log("  top unmatched genres (add rules for these):");
    out.taxonomy.unmatched
      .slice()
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 25)
      .forEach((u) => console.log(`    ${u.genre.padEnd(34)} ${u.weight}`));
  }
  console.log(
    `\n  graph ${graph.nodes.length} node(s), ${graph.links.length} link(s)` +
      ` (kept ${((graph.pruning.keptShareOfWeight || 0) * 100).toFixed(0)}% of edge weight)`
  );
  if (out.warnings.length) {
    console.log("\n  warnings:");
    out.warnings.forEach((w) => console.log(`    ${w}`));
  }
  // Volatile telemetry is logged, never written — so a no-op rerun diffs one line.
  console.log(
    `\n  ${stats.requests} request(s), ${stats.cacheHits} cache hit(s), ` +
      `${stats.retries} retry(ies), ${stats.rateLimited} rate-limit(s), ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`
  );
  if (stats.skippedEpisodes || stats.skippedLocal || stats.skippedNoArtist) {
    console.log(
      `  skipped: ${stats.skippedEpisodes} episode(s), ${stats.skippedLocal} local file(s), ` +
        `${stats.skippedNoArtist} track(s) with no artist`
    );
  }
  if (stats.playlistsForbidden || stats.playlistsMissing || stats.playlistsOversize) {
    console.log(
      `  playlists skipped: ${stats.playlistsForbidden} Spotify-owned (403), ` +
        `${stats.playlistsMissing} unavailable (404), ${stats.playlistsOversize} oversize`
    );
  }
  if (disc.seeded) {
    console.log(
      `  discovery: ${disc.totalCandidates} candidate(s) from ${disc.seeded} seed(s); ` +
        `${disc.allThree} named by all three engines`
    );
    Object.entries(disc.engines).forEach(([e, v]) =>
      console.log(`    ${e.padEnd(14)} ${String(v.suggested).padStart(4)} suggested, ${v.uniqueToIt} unique to it`)
    );
    disc.overlap.forEach((o) =>
      console.log(`    ${(o.a + " ∩ " + o.b).padEnd(28)} ${String(o.shared).padStart(4)} shared  (Jaccard ${o.jaccard})`)
    );
  }
  console.log(
    `  genre lookups: ${stats.lastfmRequests} last.fm (${stats.lastfmResolved} hit` +
      `${stats.lastfmRateLimited ? `, ${stats.lastfmRateLimited} rate-limited` : ""}), ` +
      `${stats.mbRequests} musicbrainz (${stats.mbResolved} hit), ${stats.unresolved} unresolved`
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code || 0;
  })
  .catch((err) => {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  });
