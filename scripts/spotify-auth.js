#!/usr/bin/env node
/**
 * spotify-auth.js — mint a Spotify refresh token with the scopes this site needs.
 *
 * You only run this when the scope set changes (or the token is revoked). The
 * existing token was minted for the homepage "on rotation" strip and does NOT
 * cover the library or playlists, so the genre build needs a wider one.
 *
 * Workflow:
 *   1. In the Spotify developer dashboard, add this Redirect URI to the app:
 *        http://127.0.0.1:8888/callback
 *      (Spotify rejects "localhost" — it must be the 127.0.0.1 literal.)
 *   2. Put SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.local, then:
 *        set -a; source .env.local; set +a
 *        node scripts/spotify-auth.js --write-env
 *   3. Approve in the browser window that opens.
 *   4. --write-env updates SPOTIFY_REFRESH_TOKEN in .env.local for you (mode 600).
 *      Without it, the token is printed and you copy it by hand — which is the
 *      most common way this breaks, since the token is ~130-190 chars and wraps.
 *   5. Give the Worker the same token:
 *        cd workers/spotify && wrangler secret put SPOTIFY_REFRESH_TOKEN
 *      A superset-scope token still works for the Worker, so one token serves both.
 *
 * .env.local is gitignored. Never commit it — this repo is public.
 */

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const WRITE_ENV = process.argv.includes("--write-env");
const ENV_PATH = path.join(__dirname, "..", ".env.local");

// A refresh token is ~130-190 chars and terminals soft-wrap it, so copying by
// hand is the single most common way this whole flow breaks. --write-env skips
// the human entirely.
function writeEnvLocal(token) {
  let lines = [];
  try {
    lines = fs.readFileSync(ENV_PATH, "utf8").split("\n");
  } catch (e) {
    /* no file yet — we'll create one */
  }
  const kept = lines.filter(function (l) {
    return l.trim() && !/^\s*SPOTIFY_REFRESH_TOKEN\s*=/.test(l);
  });
  kept.push("SPOTIFY_REFRESH_TOKEN=" + token);
  fs.writeFileSync(ENV_PATH, kept.join("\n") + "\n", { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);
}

// Lets you compare two copies of a secret without ever revealing one.
function fingerprint(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
}

const PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

// Everything the site needs: the homepage rotation strip + the genre build.
const SCOPES = [
  "user-library-read",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-top-read",
  "user-read-recently-played",
  "user-read-currently-playing",
].join(" ");

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  const missing = [
    !CLIENT_ID && "SPOTIFY_CLIENT_ID",
    !CLIENT_SECRET && "SPOTIFY_CLIENT_SECRET",
  ].filter(Boolean);
  console.error(`Missing required env var(s): ${missing.join(", ")}`);
  console.error("The client id is public (see workers/spotify/wrangler.jsonc);");
  console.error("the secret is in the Spotify developer dashboard.");
  process.exit(1);
}

const state = crypto.randomBytes(16).toString("hex");

const authUrl =
  "https://accounts.spotify.com/authorize?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state: state,
    show_dialog: "true",
  }).toString();

function reply(res, status, title, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta charset="utf-8">` +
      `<title>${title}</title>` +
      `<body style="font:16px/1.6 -apple-system,system-ui,sans-serif;background:#f7f3ec;` +
      `color:#211d18;display:grid;place-items:center;height:100vh;margin:0;text-align:center">` +
      `<div><h1 style="font-weight:600">${title}</h1><p>${body}</p></div>`
  );
}

async function exchangeCodeForTokens(code) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) {
    // Body can echo request params; surface the status and Spotify's error slug only.
    let slug = "";
    try {
      const data = await res.json();
      slug = data.error_description || data.error || "";
    } catch (e) {
      /* non-JSON error body — status alone is enough to diagnose */
    }
    throw new Error(`token exchange failed: ${res.status}${slug ? ` (${slug})` : ""}`);
  }
  return res.json();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get("error");
  if (error) {
    reply(res, 400, "Authorization declined", "Nothing was changed. You can close this tab.");
    console.error(`\nAuthorization declined: ${error}`);
    server.close();
    process.exitCode = 1;
    return;
  }

  if (url.searchParams.get("state") !== state) {
    reply(res, 400, "State mismatch", "The request did not originate here. Nothing was changed.");
    console.error("\nState mismatch — aborting without exchanging the code.");
    server.close();
    process.exitCode = 1;
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    reply(res, 400, "No code returned", "Spotify did not send an authorization code.");
    server.close();
    process.exitCode = 1;
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    reply(res, 200, "Done — token minted", "Copy it from your terminal. You can close this tab.");

    const granted = (tokens.scope || "").split(" ").filter(Boolean).sort();
    const wanted = SCOPES.split(" ").sort();
    const denied = wanted.filter((s) => !granted.includes(s));

    if (WRITE_ENV) {
      writeEnvLocal(tokens.refresh_token);
      console.log(`\nWrote SPOTIFY_REFRESH_TOKEN to ${ENV_PATH} (mode 600).`);
      console.log(`  length ${tokens.refresh_token.length}, fingerprint ${fingerprint(tokens.refresh_token)}`);
      console.log("  No copy/paste — nothing to mangle.");
    } else {
      console.log("\nRefresh token (store it now — it is not written to disk):\n");
      console.log(tokens.refresh_token);
      console.log(`\n  length ${tokens.refresh_token.length}, fingerprint ${fingerprint(tokens.refresh_token)}`);
      console.log("  Tip: rerun with --write-env to skip copying it by hand.");
    }
    console.log("\nScopes granted:");
    granted.forEach((s) => console.log(`  ${s}`));
    if (denied.length) {
      console.log("\nWARNING — requested but NOT granted:");
      denied.forEach((s) => console.log(`  ${s}`));
      console.log("The genre build will fail its scope preflight without these.");
      process.exitCode = 1;
    }
    console.log("\nNext:");
    console.log("  cd workers/spotify && wrangler secret put SPOTIFY_REFRESH_TOKEN");
    console.log("  …and add it to .env.local for local builds (gitignored).");
  } catch (err) {
    reply(res, 500, "Token exchange failed", "Check your terminal for details.");
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  }
  server.close();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Listening on ${REDIRECT_URI}`);
  console.log("Opening your browser to approve the scopes…");
  console.log(`If it doesn't open, paste this into a browser:\n\n${authUrl}\n`);
  execFile("open", [authUrl], (err) => {
    if (err) console.log("(couldn't auto-open a browser — use the URL above)");
  });
});
