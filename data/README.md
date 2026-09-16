# data/

Generated data for the site. **Don't edit these by hand** — they're rebuilt from
source and your edits will be overwritten.

## `spotify-genres.json`

Powers `music.html`. Regenerate with:

```sh
set -a; source .env.local; set +a      # never commit this file
node scripts/build-spotify-genres.js
```

Then commit the result. Useful flags:

| Flag | What it does |
|---|---|
| `--selftest` | run the genre-taxonomy fixtures offline and exit |
| `--explain "<genre>"` | show which rule classifies one genre |
| `--cache` | reuse cached API responses (use this while tuning the taxonomy) |
| `--limit 200` | stop after N saved tracks, for a fast run |
| `--dry-run` | compute and print the summary, write nothing |

### Where the data comes from

**Spotify no longer returns artist genres.** Its docs still list the field, but the
live API doesn't send it — a Get Artist response now contains only
`external_urls, href, id, images, name, type, uri`. Verified empirically across
438 artists, all empty.

So the pipeline is split:

| Data | Source |
|---|---|
| Saved tracks, playlists, top artists/tracks, recent plays | Spotify Web API |
| Genres per artist | Last.fm `artist.getTopTags`, falling back to MusicBrainz |

Genre sources are matched on the artist **name** — the accuracy limit of the whole
page. Same-named artists collide; obscure artists resolve to nothing.

### Before the first run

The Spotify refresh token needs these scopes:

```
user-library-read playlist-read-private user-top-read
user-read-recently-played user-read-currently-playing
```

You also need a **free Last.fm API key** (no OAuth, instant):
<https://www.last.fm/api/account/create> → add `LASTFM_API_KEY=...` to `.env.local`.
MusicBrainz needs no key, just the User-Agent the script already sends; it's hard
limited to 1 request/second, so it's the fallback rather than the primary.
Pass `--no-musicbrainz` to skip the fallback and finish faster with thinner coverage.

The token behind the homepage "on rotation" strip predates this page and is
missing the first two. Mint a wider one with `node scripts/spotify-auth.js` —
a superset token still works for the Worker, so one token serves both. The
script checks scopes up front, so a missing one fails in four requests rather
than three minutes in.

### Things worth knowing

- **Playlist names are not committed.** This repo is public, so playlists are
  analysed but labelled generically. `--playlist-names full` overrides that;
  think before you use it.
- **Reruns should produce a one-line diff.** Every array is sorted by a stable
  key and floats are rounded at serialization, so if nothing changed upstream
  only `asOf` moves. A noisy diff means something actually changed.
- **Read the coverage summary.** It prints what share of your listening had no
  genre at all (Spotify's gap) versus what hit no rule (this repo's gap), plus
  the top unmatched genres. That list is the to-do for the taxonomy table.

## `listening-history.json`

Powers the "A year of plays" section of `music.html`. It comes from Spotify's
**account-data export**, not the API — the API stops at the last 50 plays, the
export carries roughly a year of them with durations.

1. Request it at <https://www.spotify.com/account/privacy/> → "Account data"
   (the plain one, not "Extended streaming history"). It arrives by email as
   `my_spotify_data.zip` within a few days.
2. Build straight from the zip — never unpack it into the repo, it holds your
   email, birthdate and every search you've typed:

```sh
node scripts/build-listening-history.js --from ~/Downloads/my_spotify_data.zip
```

| Flag | What it does |
|---|---|
| `--tz America/Los_Angeles` | local zone for the hour-of-day chart |
| `--no-genres` | skip genre lookups entirely; the family-mix chart is then hidden |
| `--resolve-share 0.9` | look up genres for the most-played artists until this share of play time is covered |
| `--resolve-limit N` | cap lookups for this run (it checkpoints every 50 and resumes) |
| `--dry-run` | print the summary, write nothing |

Genres use the same rule table and providers as the genre build, matched on
artist **name** because the export has no ids. Lookups are cached in
`.cache/spotify/history-artists.json`; the genre page's own data seeds it, so a
fresh clone starts about a third resolved. Without `LASTFM_API_KEY` it falls
back to MusicBrainz at one request a second — budget most of an hour for a
first run, and expect roughly half the obscure names to come back empty. The
page hides the family-mix chart unless at least half of play time is classified.

Only aggregates are written: totals, per-month counts, a weekday × hour grid,
the top 20 artists and top 12 tracks, and family shares. No individual plays,
no timestamps finer than the hour.
