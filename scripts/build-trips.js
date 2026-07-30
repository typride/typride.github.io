#!/usr/bin/env node
/**
 * build-trips.js — regenerate images/trips/manifest.json from the folders.
 *
 * Workflow:
 *   1. Drop photos into  images/trips/<place-slug>/   (e.g. images/trips/kyoto-japan/)
 *   2. Run:  node scripts/build-trips.js
 *   3. Commit + push. The matching map pin starts pulsing and opens a lightbox.
 *
 * The <place-slug> is the pin name lowercased with non-alphanumerics turned to
 * dashes — e.g. "Kyoto, Japan" -> "kyoto-japan". See images/trips/README.md for
 * the full slug list.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TRIPS = path.join(ROOT, "images", "trips");
const IMG = /\.(jpe?g|png|webp|gif|avif)$/i;

const manifest = {};
if (fs.existsSync(TRIPS)) {
  for (const slug of fs.readdirSync(TRIPS).sort()) {
    const dir = path.join(TRIPS, slug);
    let stat;
    try { stat = fs.statSync(dir); } catch (e) { continue; }
    if (!stat.isDirectory()) continue;
    const photos = fs.readdirSync(dir).filter((f) => IMG.test(f)).sort();
    if (photos.length) manifest[slug] = photos;
  }
}

fs.mkdirSync(TRIPS, { recursive: true });
fs.writeFileSync(path.join(TRIPS, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const total = Object.values(manifest).reduce((n, p) => n + p.length, 0);
console.log(`Wrote images/trips/manifest.json — ${Object.keys(manifest).length} trip(s), ${total} photo(s):`);
Object.entries(manifest).forEach(([s, p]) => console.log(`  ${s.padEnd(28)} ${p.length}`));
