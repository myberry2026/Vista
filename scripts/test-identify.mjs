#!/usr/bin/env node
/**
 * Smoke test for the question-branch identifyPlace function.
 *
 * Usage:
 *   node scripts/test-identify.mjs <image-path> <lat> <lng> "<question>"
 *
 * Examples:
 *   # Famous landmark
 *   node scripts/test-identify.mjs ./eiffel.jpg 48.8584 2.2945 "what's that tower?"
 *
 *   # Generic building near coords (proves Maps grounding)
 *   node scripts/test-identify.mjs ./office.jpg 37.4221 -122.0841 "what's that building?"
 *
 *   # Chinese question — output must come back in Chinese
 *   node scripts/test-identify.mjs ./eiffel.jpg 48.8584 2.2945 "左边那个塔是什么？"
 *
 *   # Defaults: no args fetches a small Eiffel Tower Street View frame.
 *   node scripts/test-identify.mjs
 *
 * Requires GEMINI_API_KEY in .env.local (or environment). Exits 0 on a
 * successful call, 1 on any failure (network, parse, missing key).
 */

import fs from 'node:fs';
import path from 'node:path';
import { identifyPlace } from '../question-branch.js';

const DEFAULT_LAT = 48.8584;
const DEFAULT_LNG = 2.2945;
const DEFAULT_QUESTION = "what is that tall iron tower in front of us?";

async function loadFrame(imagePath, lat, lng) {
  if (imagePath && fs.existsSync(imagePath)) {
    const buf = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
    return { base64: buf.toString('base64'), mimeType, source: imagePath };
  }

  // Fallback: fetch a Street View static image at the given coords so the test
  // works out of the box. Uses VITE_GOOGLE_MAPS_API_KEY from .env.local.
  const mapsKey = process.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!mapsKey) {
    throw new Error(
      'No image path provided and VITE_GOOGLE_MAPS_API_KEY is not set. ' +
      'Pass an image: node scripts/test-identify.mjs <image-path> <lat> <lng> "<question>"',
    );
  }
  const url = `https://maps.googleapis.com/maps/api/streetview?size=640x640&location=${lat},${lng}&fov=80&key=${mapsKey}`;
  console.log(`[smoke] No image given. Fetching Street View frame at ${lat},${lng}...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Street View fetch failed: HTTP ${resp.status}`);
  const ab = await resp.arrayBuffer();
  return {
    base64: Buffer.from(ab).toString('base64'),
    mimeType: 'image/jpeg',
    source: `streetview@${lat},${lng}`,
  };
}

function fmtSources(sources) {
  if (!sources.length) return '  (none)';
  return sources
    .map((s, i) => `  [${i + 1}] (${s.type}) ${s.title || '<no title>'} — ${s.uri || '<no uri>'}`)
    .join('\n');
}

async function main() {
  const [imagePath, latArg, lngArg, ...qParts] = process.argv.slice(2);
  const lat = latArg ? Number(latArg) : DEFAULT_LAT;
  const lng = lngArg ? Number(lngArg) : DEFAULT_LNG;
  const question = qParts.length ? qParts.join(' ') : DEFAULT_QUESTION;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    console.error('Bad lat/lng');
    process.exit(1);
  }

  const frame = await loadFrame(imagePath, lat, lng);

  console.log('─── Input ──────────────────────────────────────────────');
  console.log(`  image:     ${frame.source} (${frame.mimeType}, ${frame.base64.length} b64 chars)`);
  console.log(`  location:  ${lat}, ${lng}`);
  console.log(`  question:  "${question}"`);
  console.log('');

  const t0 = Date.now();
  const result = await identifyPlace(frame.base64, lat, lng, question, frame.mimeType, { debug: true });
  const elapsedMs = Date.now() - t0;

  console.log('─── Parsed result ──────────────────────────────────────');
  console.log(`  name:        ${result.name ?? '(null)'}`);
  console.log(`  category:    ${result.category}`);
  console.log(`  tier:        ${result.tier}`);
  console.log(`  confidence:  ${result.confidence}`);
  console.log(`  description: ${result.description}`);
  console.log(`  sources:`);
  console.log(fmtSources(result.sources));
  console.log('');

  console.log('─── Grounding debug ────────────────────────────────────');
  const d = result._debug || {};
  console.log(`  model:                    ${d.model}`);
  console.log(`  Maps grounding chunks:    ${d.mapsChunkCount ?? 0}`);
  console.log(`  Web (Search) chunks:      ${d.webChunkCount ?? 0}`);
  console.log(`  Search queries fired:     ${JSON.stringify(d.searchQueries || [])}`);
  console.log(`  Search Suggestions HTML:  ${d.searchSuggestionsHtml ? `${d.searchSuggestionsHtml.length} chars` : '(none)'}`);
  console.log(`  Maps widget context:      ${d.widgetContextToken ? 'present' : '(none)'}`);
  console.log(`  Elapsed:                  ${elapsedMs} ms`);
  console.log('');

  console.log('─── Raw model text ─────────────────────────────────────');
  console.log(d.modelText || '(empty)');
  console.log('');

  console.log('─── Raw response candidates[0] (truncated) ─────────────');
  const cand = result._raw?.candidates?.[0];
  if (cand) {
    const printable = {
      finishReason: cand.finishReason,
      groundingMetadata: cand.groundingMetadata
        ? {
            groundingChunksCount: cand.groundingMetadata.groundingChunks?.length || 0,
            webSearchQueries: cand.groundingMetadata.webSearchQueries,
            hasSearchEntryPoint: !!cand.groundingMetadata.searchEntryPoint,
            googleMapsWidgetContextToken: cand.groundingMetadata.googleMapsWidgetContextToken
              ? '<token>'
              : undefined,
            firstChunkSample: cand.groundingMetadata.groundingChunks?.[0],
          }
        : null,
    };
    console.log(JSON.stringify(printable, null, 2));
  } else {
    console.log('(no candidates)');
  }

  // Sanity check the integration: Maps OR Search grounding must have actually
  // fired. If neither chunks nor queries showed up, the test is not exercising
  // grounding and should not be considered green.
  const groundingFired =
    (d.mapsChunkCount && d.mapsChunkCount > 0) ||
    (d.webChunkCount && d.webChunkCount > 0) ||
    (d.searchQueries && d.searchQueries.length > 0);
  if (!groundingFired) {
    console.warn('\n⚠️  No grounding chunks or search queries detected. ' +
      'Verify the model supports combined Maps + Search grounding on this account.');
  } else {
    console.log('\n✅ Grounding fired (Maps and/or Search produced metadata).');
  }
}

main().catch((err) => {
  console.error('[smoke] Failed:', err?.stack || err);
  process.exit(1);
});
