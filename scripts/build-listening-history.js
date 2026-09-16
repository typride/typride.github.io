#!/usr/bin/env node
/*
 * build-listening-history.js — turn Spotify's account-data export into
 * data/listening-history.json for music.html's "A year of plays" section.
 *
 * The Web API caps history at the last 50 plays, so this is the only source
 * of continuous listening: every play (over ~30s or not) for roughly the last
 * twelve months. Request the export at spotify.com/account/privacy ("Account
 * data", not the extended one); it arrives as my_spotify_data.zip.
 *
 *   node scripts/build-listening-history.js --from ~/Downloads/my_spotify_data.zip
 *
 *   --from <zip|dir>     the export zip, or an unzipped "Spotify Account Data" dir
 *   --tz <IANA zone>     local zone for hour-of-day (default America/Los_Angeles)
 *   --no-genres          skip all genre lookups; families section is omitted
 *   --resolve-share 0.9  resolve genres for artists covering this share of
 *                        play time, most-played first (default 0.9)
 *   --resolve-limit N    hard cap on artists to look up this run
 *   --dry-run            print the summary, write nothing
 *
 * Genres come from the same providers and rule table as build-spotify-genres.js
 * (Last.fm if LASTFM_API_KEY is set, else MusicBrainz at 1 req/sec), keyed by
 * artist NAME because the export carries no artist ids. Lookups are cached in
 * .cache/spotify/history-artists.json and never re-asked once answered.
 *
 * The raw export holds email, birthdate and every search query. Nothing but
 * aggregates leaves this script; the zip itself must never enter the repo.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const tax = require("./build-spotify-genres.js");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data", "listening-history.json");
const SITE_JSON = path.join(ROOT, "data", "spotify-genres.json");
const CACHE_DIR = path.join(ROOT, ".cache", "spotify");
const NAME_CACHE = path.join(CACHE_DIR, "history-artists.json");

const FULL_PLAY_MS = 30000; // Spotify's own threshold for a counted stream
const TOP_ARTISTS = 20;
const TOP_TRACKS = 12;
const MIN_DAYS_FOR_MONTH = 7; // a month with less coverage is totals-only
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ---------- cli ----------------------------------------------------------

function parseArgs(argv) {
  const o = { tz: "America/Los_Angeles", genres: true, resolveShare: 0.9, resolveLimit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") o.from = argv[++i];
    else if (a === "--tz") o.tz = argv[++i];
    else if (a === "--no-genres") o.genres = false;
    else if (a === "--resolve-share") o.resolveShare = Number(argv[++i]);
    else if (a === "--resolve-limit") o.resolveLimit = Number(argv[++i]);
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

// ---------- reading the export -------------------------------------------

function readExport(from) {
  if (!from) throw new Error("--from <my_spotify_data.zip | dir> is required");
  const src = path.resolve(from.replace(/^~/, process.env.HOME || ""));
  if (!fs.existsSync(src)) throw new Error(`not found: ${src}`);

  let names;
  let read;
  if (fs.statSync(src).isDirectory()) {
    // Accept either the zip's parent or the "Spotify Account Data" dir itself.
    const inner = path.join(src, "Spotify Account Data");
    const dir = fs.existsSync(inner) ? inner : src;
    names = fs.readdirSync(dir);
    read = (n) => fs.readFileSync(path.join(dir, n), "utf8");
  } else {
    const list = execFileSync("unzip", ["-Z1", src], { encoding: "utf8" });
    names = list.split("\n").map((l) => l.replace(/^Spotify Account Data\//, "")).filter(Boolean);
    read = (n) =>
      execFileSync("unzip", ["-p", src, `Spotify Account Data/${n}`], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
  }

  const music = names.filter((n) => /^StreamingHistory_music_\d+\.json$/.test(n)).sort();
  if (!music.length) throw new Error("no StreamingHistory_music_*.json in the export");
  const plays = [];
  for (const n of music) plays.push(...JSON.parse(read(n)));

  const podcastFiles = names.filter((n) => /^StreamingHistory_podcast_\d+\.json$/.test(n));
  const podcasts = [];
  for (const n of podcastFiles) podcasts.push(...JSON.parse(read(n)));

  return { plays, podcasts };
}

// ---------- time ----------------------------------------------------------

// The export's endTime is UTC to the minute. Attribute each play to the hour
// it STARTED in the local zone — a three-hour sleep loop that ends at 07:00
// belongs to the night, not the morning.
function localParts(tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short",
  });
  return (date) => {
    const p = {};
    for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
    const hour = Number(p.hour) % 24; // "24" at midnight on some engines
    return {
      day: `${p.year}-${p.month}-${p.day}`,
      month: `${p.year}-${p.month}`,
      hour,
      weekday: WEEKDAYS.indexOf(p.weekday), // 0 = Mon … 6 = Sun
    };
  };
}

function parseEnd(s) {
  // "2025-09-03 05:11" → UTC Date
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
}

function daysInMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ---------- genres --------------------------------------------------------

function loadNameCache() {
  try {
    return JSON.parse(fs.readFileSync(NAME_CACHE, "utf8"));
  } catch (e) {
    return {};
  }
}

function saveNameCache(cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const sorted = {};
  Object.keys(cache).sort().forEach((k) => (sorted[k] = cache[k]));
  fs.writeFileSync(NAME_CACHE, JSON.stringify(sorted, null, 2) + "\n");
}

// Seed the name cache from whatever the genre page already knows, so a fresh
// clone starts at a third of play time resolved instead of zero.
function seedFromSite(cache) {
  let seeded = 0;
  // The id-keyed cache from the genre build, if this checkout has one.
  const byId = tax.loadArtistCache();
  byId.forEach((a) => {
    if (!a || !a.name || cache[a.name]) return;
    if (a.source && a.source !== "none") {
      cache[a.name] = { genres: a.genres || [], source: a.source };
      seeded++;
    }
  });
  // The committed JSON: genre → example artists, plus the top-artist list.
  let site = null;
  try {
    site = JSON.parse(fs.readFileSync(SITE_JSON, "utf8"));
  } catch (e) {
    return seeded;
  }
  const inv = {};
  Object.entries(site.genreExamples || {}).forEach(([g, arts]) => {
    (arts || []).forEach((a) => {
      (inv[a] = inv[a] || new Set()).add(g);
    });
  });
  (site.artists || []).forEach((a) => {
    (inv[a.name] = inv[a.name] || new Set());
    (a.genres || []).forEach((g) => inv[a.name].add(g));
  });
  Object.entries(inv).forEach(([name, gs]) => {
    if (cache[name] || !gs.size) return;
    cache[name] = { genres: [...gs].sort(), source: "site" };
    seeded++;
  });
  return seeded;
}

async function resolveNames(names, cache, opts) {
  const env = { lastfmKey: process.env.LASTFM_API_KEY };
  const need = names.filter((n) => !cache[n]).slice(0, opts.resolveLimit);
  if (!need.length) return { asked: 0, hit: 0 };
  const via = env.lastfmKey ? "Last.fm (MusicBrainz fallback)" : "MusicBrainz only, 1 req/sec";
  const mins = env.lastfmKey ? Math.ceil(need.length / 240) : Math.ceil((need.length * 2.3) / 60);
  console.log(`  resolving ${need.length} artist(s) via ${via} — roughly ${mins} minute(s), checkpointed every 50`);

  const started = Date.now();
  let hit = 0;
  let skipped = 0;
  for (let i = 0; i < need.length; i++) {
    const name = need[i];
    let genres = null;
    let source = "none";
    if (env.lastfmKey) {
      try {
        genres = await tax.lastfmTags(env, name);
        if (genres && genres.length) source = "lastfm";
      } catch (e) {
        /* fall through */
      }
    }
    if (!genres || !genres.length) {
      const mb = await musicbrainzLookup(name);
      if (mb === undefined) {
        // Transient failure: leave the name uncached so the next run asks again.
        skipped++;
        continue;
      }
      if (mb && mb.length) {
        genres = mb;
        source = "musicbrainz";
      }
    }
    cache[name] = { genres: genres || [], source };
    if (source !== "none") hit++;
    const done = i + 1;
    if (done % 10 === 0 || done === need.length) {
      const rate = done / ((Date.now() - started) / 1000);
      const eta = Math.round((need.length - done) / rate);
      process.stdout.write(`\r  genres… ${done}/${need.length}  ${hit} resolved  ~${Math.floor(eta / 60)}m${String(eta % 60).padStart(2, "0")}s left   `);
    }
    if (done % 50 === 0) saveNameCache(cache);
  }
  process.stdout.write("\r" + " ".repeat(90) + "\r");
  saveNameCache(cache);
  if (skipped) console.log(`  ${skipped} lookup(s) failed transiently and were left uncached — rerun to retry them`);
  return { asked: need.length, hit };
}

// MusicBrainz, with the distinction the shared helper lacks: "the server was
// busy" (undefined — ask again next run) versus "it has never heard of this
// artist" ([] — a definitive answer worth caching). A hard 1 req/sec.
const MB_UA = "typride-genre-viz/1.0 ( https://typride.github.io )";
const MB_HEADERS = { "User-Agent": MB_UA, Accept: "application/json" };
let mbLast = 0;
async function mbGet(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const gap = Date.now() - mbLast;
    if (gap < 1100) await new Promise((r) => setTimeout(r, 1100 - gap));
    mbLast = Date.now();
    let res;
    try {
      res = await fetch(url, { headers: MB_HEADERS, signal: AbortSignal.timeout(20000) });
    } catch (e) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    if (res.status === 503 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    const body = await res.json();
    // MB answers "busy" with a 200 and an error body.
    if (body && body.error) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    return body;
  }
  return undefined;
}

async function musicbrainzLookup(name) {
  const found = await mbGet(
    "https://musicbrainz.org/ws/2/artist?fmt=json&limit=1&query=" + encodeURIComponent(`artist:"${name}"`)
  );
  if (found === undefined) return undefined;
  const hit = found && found.artists && found.artists[0];
  // Search is fuzzy and returns *something* for anything; only a confident
  // name match counts.
  if (!hit || !hit.id || Number(hit.score) < 90) return [];
  const a = await mbGet(`https://musicbrainz.org/ws/2/artist/${hit.id}?fmt=json&inc=genres+tags`);
  if (a === undefined) return undefined;
  if (!a) return [];
  const curated = (a.genres || []).map((g) => g && g.name).filter(Boolean);
  if (curated.length) return tax.cleanTags(curated);
  const tags = (a.tags || []).filter((t) => Number(t && t.count) > 0).map((t) => t && t.name).filter(Boolean);
  return tax.cleanTags(tags);
}

// ---------- assembly -------------------------------------------------------

function r(n, dp) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

const hours = (ms) => ms / 3600000;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^#![^\n]*\n/, ""));
    return 0;
  }
  if (tax.runSelftest() !== 0) {
    console.error("\nRefusing to build with failing taxonomy fixtures.");
    return 1;
  }
  console.log("");

  const { plays: raw, podcasts } = readExport(opts.from);
  const toLocal = localParts(opts.tz);

  // Normalise every play once.
  const plays = [];
  let dropped = 0;
  for (const p of raw) {
    const end = parseEnd(p.endTime);
    const ms = Number(p.msPlayed) || 0;
    if (!end || !p.artistName || !p.trackName) {
      dropped++;
      continue;
    }
    const start = new Date(end.getTime() - ms);
    plays.push({ ...toLocal(start), ms, artist: p.artistName, track: p.trackName, full: ms >= FULL_PLAY_MS, t: start.getTime() });
  }
  plays.sort((a, b) => a.t - b.t);
  if (!plays.length) throw new Error("no usable plays in the export");
  console.log(`  ${plays.length} plays read (${dropped} malformed dropped), ${opts.tz}`);

  // ---- totals
  const totalMs = plays.reduce((a, p) => a + p.ms, 0);
  const artistMs = new Map();
  const artistPlays = new Map();
  const artistFirst = new Map();
  const trackAgg = new Map();
  for (const p of plays) {
    artistMs.set(p.artist, (artistMs.get(p.artist) || 0) + p.ms);
    if (p.full) artistPlays.set(p.artist, (artistPlays.get(p.artist) || 0) + 1);
    if (!artistFirst.has(p.artist)) artistFirst.set(p.artist, p.month);
    const k = p.artist + " " + p.track;
    const t = trackAgg.get(k) || { artist: p.artist, track: p.track, plays: 0, ms: 0 };
    if (p.full) t.plays++;
    t.ms += p.ms;
    trackAgg.set(k, t);
  }
  const fullPlays = plays.filter((p) => p.full).length;
  const days = new Set(plays.map((p) => p.day));
  const firstDay = plays[0].day;
  const lastDay = plays[plays.length - 1].day;

  // ---- months
  const monthMap = new Map();
  for (const p of plays) {
    const m = monthMap.get(p.month) || { month: p.month, ms: 0, plays: 0, fullPlays: 0, artists: new Set(), newArtists: 0, days: new Set() };
    m.ms += p.ms;
    m.plays++;
    if (p.full) m.fullPlays++;
    m.artists.add(p.artist);
    m.days.add(p.day);
    monthMap.set(p.month, m);
  }
  artistFirst.forEach((month) => {
    const m = monthMap.get(month);
    if (m) m.newArtists++;
  });
  const monthsAll = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month));
  const months = monthsAll.map((m, i) => ({
    month: m.month,
    hours: r(hours(m.ms), 2),
    plays: m.plays,
    fullPlays: m.fullPlays,
    artists: m.artists.size,
    // Everyone is "new" in the first month of a window; the page must not
    // draw that point as discovery.
    newArtists: i === 0 ? null : m.newArtists,
    daysCovered: m.days.size,
    daysInMonth: daysInMonth(m.month),
    partial: m.days.size < MIN_DAYS_FOR_MONTH,
  }));

  // ---- weekday × hour, in hours listened
  const week = WEEKDAYS.map(() => new Array(24).fill(0));
  for (const p of plays) if (p.weekday >= 0) week[p.weekday][p.hour] += hours(p.ms);
  const weekHours = week.map((row) => row.map((h) => r(h, 3)));

  // ---- top lists
  const topArtists = [...artistMs.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_ARTISTS)
    .map(([name, ms]) => ({ name, hours: r(hours(ms), 2), plays: artistPlays.get(name) || 0, firstSeen: artistFirst.get(name) }));
  const topTracks = [...trackAgg.values()]
    .sort((a, b) => b.plays - a.plays || b.ms - a.ms || a.track.localeCompare(b.track))
    .slice(0, TOP_TRACKS)
    .map((t) => ({ artist: t.artist, track: t.track, plays: t.plays, hours: r(hours(t.ms), 2) }));

  // ---- genres → families, weighted by time, 1/N per genre
  let familiesYear = null;
  let familiesByMonth = null;
  let coverage = null;
  let resolvedNote = null;
  if (opts.genres) {
    const cache = loadNameCache();
    const seeded = seedFromSite(cache);
    if (seeded) console.log(`  ${seeded} artist(s) seeded from the genre page's data`);

    // Most-played first, up to the requested share of play time.
    const ranked = [...artistMs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const wanted = [];
    let cum = 0;
    for (const [name, ms] of ranked) {
      if (cum / totalMs >= opts.resolveShare) break;
      cum += ms;
      wanted.push(name);
    }
    const res = await resolveNames(wanted, cache, opts);
    if (res.asked) console.log(`  ${res.hit}/${res.asked} newly resolved`);

    const famMs = new Map();
    const famByMonth = new Map();
    let coveredMs = 0;
    let coveredArtists = 0;
    const sources = {};
    artistMs.forEach((ms, name) => {
      const e = cache[name];
      const gs = e ? tax.cleanTags(e.genres || []) : [];
      if (gs.length) {
        coveredArtists++;
        sources[e.source] = (sources[e.source] || 0) + 1;
      }
    });
    for (const p of plays) {
      const e = cache[p.artist];
      const gs = e ? tax.cleanTags(e.genres || []) : [];
      if (!gs.length) continue;
      coveredMs += p.ms;
      const w = p.ms / gs.length;
      const mrow = famByMonth.get(p.month) || new Map();
      for (const g of gs) {
        const fam = tax.classifyGenre(g).family;
        famMs.set(fam, (famMs.get(fam) || 0) + w);
        mrow.set(fam, (mrow.get(fam) || 0) + w);
      }
      famByMonth.set(p.month, mrow);
    }
    familiesYear = [...famMs.entries()]
      .map(([family, ms]) => ({ family, hours: r(hours(ms), 2), share: r(ms / coveredMs, 4) }))
      .sort((a, b) => b.share - a.share || a.family.localeCompare(b.family));
    familiesByMonth = months.map((m) => {
      const row = famByMonth.get(m.month) || new Map();
      let tot = 0;
      row.forEach((v) => (tot += v));
      const monthMs = monthMap.get(m.month).ms;
      const fams = {};
      [...row.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([f, v]) => (fams[f] = r(v / tot, 4)));
      return { month: m.month, coveredShare: r(tot / monthMs, 4), families: fams };
    });
    coverage = {
      timeShare: r(coveredMs / totalMs, 4),
      artistsResolved: coveredArtists,
      artistsTotal: artistMs.size,
      askedShare: opts.resolveShare,
      sources,
    };
    resolvedNote =
      "Genres are looked up by artist name (the export has no ids), most-played artists first, " +
      `until ${Math.round(opts.resolveShare * 100)}% of play time was covered or the source ran dry. ` +
      "Artists with no genre anywhere are left out of the family mix and counted in the coverage figure.";
    console.log(
      `  genre coverage: ${(coverage.timeShare * 100).toFixed(1)}% of play time, ` +
        `${coveredArtists}/${artistMs.size} artists (${Object.entries(sources).map(([k, v]) => `${v} ${k}`).join(", ")})`
    );
  }

  const podcastMs = podcasts.reduce((a, p) => a + (Number(p.msPlayed) || 0), 0);

  const out = {
    schemaVersion: 1,
    asOf: new Date().toISOString(),
    generatedBy: "scripts/build-listening-history.js",
    provenance: {
      listening: "Spotify account-data export (StreamingHistory_music_*.json): every play in the last ~12 months, with duration",
      genres: opts.genres ? "Same providers and rule table as the genre page, matched on artist name" : null,
      timezone: opts.tz,
    },
    notes: {
      fullPlay: `A "full play" is ${FULL_PLAY_MS / 1000}s or longer, Spotify's own threshold for counting a stream. Shorter ones are skips.`,
      hourOfDay: "Each play is attributed to the local hour it started, not the hour it ended.",
      newArtists: "An artist is new in the month it first appears in this window. The first month is null by construction.",
      partialMonths: `Months with fewer than ${MIN_DAYS_FOR_MONTH} days of listening are flagged partial; they sit in the totals but should not be drawn.`,
      genres: resolvedNote,
    },
    span: { from: firstDay, to: lastDay, days: days.size },
    totals: {
      plays: plays.length,
      fullPlays,
      skips: plays.length - fullPlays,
      skipShare: r((plays.length - fullPlays) / plays.length, 4),
      hours: r(hours(totalMs), 1),
      hoursPerDay: r(hours(totalMs) / Math.max(1, days.size), 2),
      artists: artistMs.size,
      tracks: trackAgg.size,
      podcastHours: r(hours(podcastMs), 1),
      podcastPlays: podcasts.length,
    },
    months,
    weekdays: WEEKDAYS.slice(),
    weekHours,
    topArtists,
    topTracks,
    genreCoverage: coverage,
    familiesYear,
    familiesByMonth,
  };

  console.log(
    `\n  ${out.span.from} → ${out.span.to}: ${out.totals.hours}h across ${out.totals.plays} plays ` +
      `(${(out.totals.skipShare * 100).toFixed(0)}% under 30s), ${out.totals.artists} artists, ${out.totals.tracks} tracks`
  );
  console.log(`  months: ${months.map((m) => `${m.month.slice(2)} ${Math.round(m.hours)}h${m.partial ? "*" : ""}`).join(" · ")}`);
  console.log(`  top: ${topArtists.slice(0, 5).map((a) => `${a.name} ${a.hours}h`).join(" · ")}`);
  if (familiesYear) console.log(`  families: ${familiesYear.slice(0, 5).map((f) => `${f.family} ${(f.share * 100).toFixed(0)}%`).join(" · ")}`);

  if (opts.dryRun) {
    console.log("  --dry-run: nothing written");
    return 0;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`  wrote ${path.relative(ROOT, OUT)}`);
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
