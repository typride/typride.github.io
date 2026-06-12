// Read-only Spotify proxy for typride.github.io.
// Holds the refresh token server-side and exposes a slim JSON summary:
// now playing (or last played), top artists, and top tracks this month.

const ALLOWED_ORIGINS = [
  "https://typride.github.io",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const headers = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Vary": "Origin",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    try {
      const token = await getAccessToken(env);
      const api = (path) =>
        fetch(`https://api.spotify.com/v1${path}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

      const [nowRes, artistsRes, tracksRes, recentRes] = await Promise.all([
        api("/me/player/currently-playing"),
        api("/me/top/artists?limit=6&time_range=short_term"),
        api("/me/top/tracks?limit=5&time_range=short_term"),
        api("/me/player/recently-played?limit=1"),
      ]);

      const payload = {
        nowPlaying: await parseNowPlaying(nowRes),
        lastPlayed: await parseRecent(recentRes),
        topArtists: await parseTopArtists(artistsRes),
        topTracks: await parseTopTracks(tracksRes),
        asOf: new Date().toISOString(),
      };

      return new Response(JSON.stringify(payload), { headers });
    } catch (err) {
      console.error(JSON.stringify({ event: "spotify_proxy_error", message: err.message }));
      return new Response(JSON.stringify({ error: "unavailable" }), { status: 502, headers });
    }
  },
};

async function getAccessToken(env) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env.SPOTIFY_REFRESH_TOKEN,
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

function slimTrack(item) {
  if (!item || item.type === "episode") return null;
  return {
    id: item.id || null,
    track: item.name,
    artist: (item.artists || []).map((a) => a.name).join(", "),
    url: item.external_urls?.spotify || null,
    image: smallestImage(item.album?.images),
  };
}

function smallestImage(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  return images[images.length - 1].url;
}

async function parseNowPlaying(res) {
  // 204 = nothing playing right now.
  if (res.status !== 200) return null;
  const data = await res.json();
  if (!data.is_playing) return null;
  return slimTrack(data.item);
}

async function parseRecent(res) {
  if (!res.ok) return null;
  const data = await res.json();
  return slimTrack(data.items?.[0]?.track);
}

async function parseTopArtists(res) {
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || []).map((a) => ({
    name: a.name,
    url: a.external_urls?.spotify || null,
    genre: a.genres?.[0] || null,
  }));
}

async function parseTopTracks(res) {
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || []).map((t) => ({
    track: t.name,
    artist: (t.artists || []).map((a) => a.name).join(", "),
    url: t.external_urls?.spotify || null,
  }));
}
