#!/usr/bin/env node
/**
 * Smoke test for tour-planning: planTour + state machine + mid-tour question.
 *
 * Usage:
 *   node scripts/test-plan-tour.mjs            # runs both Stanford + Torres del Paine
 *   node scripts/test-plan-tour.mjs "Kyoto"    # plans one custom area
 *
 * Requires GEMINI_API_KEY in .env.local. Exits 0 on success, 1 on failure.
 */

import fs from 'node:fs';
import { planTour, TourStateMachine, handleMidTourQuestion } from '../tour-planning.js';

const SEPARATOR = '═'.repeat(72);

function fmtStop(stop, indent = '  ') {
  return [
    `${indent}#${stop.order} ${stop.name}  [${stop.stop_type}, ${stop.duration_sec}s]`,
    `${indent}  map_query: ${stop.map_query}`,
    `${indent}  look_for:  ${stop.look_for}`,
    `${indent}  narration: ${stop.narration}`,
  ].join('\n');
}

function fmtSources(sources, indent = '  ') {
  if (!sources?.length) return `${indent}(none)`;
  return sources
    .map((s, i) => `${indent}[${i + 1}] (${s.type}) ${s.title || '<no title>'} — ${s.uri || '<no uri>'}`)
    .join('\n');
}

function fmtTransition(t) {
  if (t.done) return `  done=true | narration: ${t.narration}`;
  return `  current=${t.current} (${t.stop.name}) | map_query="${t.map_query}" | look_for="${t.look_for}"`;
}

function validateItinerary(itin, areaLabel) {
  const issues = [];
  if (itin.intent !== 'guided_tour') issues.push(`intent != 'guided_tour' (got ${itin.intent})`);
  if (!itin.tour_title) issues.push('missing tour_title');
  if (!Array.isArray(itin.stops) || itin.stops.length < 4) {
    issues.push(`expected 4-6 stops, got ${itin.stops?.length ?? 0}`);
  }
  if (itin.stops?.length > 6) issues.push(`expected <=6 stops, got ${itin.stops.length}`);
  itin.stops?.forEach((s, i) => {
    if (s.order !== i + 1) issues.push(`stops[${i}].order should be ${i + 1}, got ${s.order}`);
    if (!s.name || !s.map_query || !s.narration || !s.look_for) issues.push(`stops[${i}] missing required field`);
  });
  return issues;
}

async function runArea(area, { exerciseStateMachine = false } = {}) {
  console.log(SEPARATOR);
  console.log(`📍 Planning tour: ${area}`);
  console.log(SEPARATOR);

  const t0 = Date.now();
  const itin = await planTour(area, undefined, { debug: true });
  const ms = Date.now() - t0;

  if (itin.error) {
    console.log(`  ❌ planTour returned error: ${itin.error}`);
    return { itin, ok: false };
  }

  console.log(`  Title: ${itin.tour_title}`);
  console.log(`  Area:  ${itin.area}`);
  console.log(`  Stops: ${itin.stops.length}  (elapsed: ${ms} ms)\n`);
  itin.stops.forEach(s => console.log(fmtStop(s) + '\n'));

  console.log('  ─── Sources ───');
  console.log(fmtSources(itin.sources));

  console.log('\n  ─── Grounding debug ───');
  const d = itin._debug || {};
  console.log(`    model:                ${d.model}`);
  console.log(`    Maps chunks:          ${d.mapsChunkCount ?? 0}`);
  console.log(`    Web (Search) chunks:  ${d.webChunkCount ?? 0}`);
  console.log(`    Search queries:       ${JSON.stringify(d.searchQueries || [])}`);
  console.log(`    Search Suggestions:   ${d.searchSuggestionsHtml ? `${d.searchSuggestionsHtml.length} chars` : '(none)'}`);

  const issues = validateItinerary(itin, area);
  if (issues.length) {
    console.log('\n  ⚠️  Contract issues:');
    issues.forEach(x => console.log(`    - ${x}`));
  } else {
    console.log('\n  ✅ Contract OK');
  }

  if (exerciseStateMachine) {
    console.log('\n  ─── State machine walkthrough ───');
    const sm = new TourStateMachine(itin);
    console.log('  start():'); console.log(fmtTransition(sm.start()));
    console.log('  next():');  console.log(fmtTransition(sm.next()));
    console.log('  next():');  console.log(fmtTransition(sm.next()));
    console.log('  back():');  console.log(fmtTransition(sm.back()));
    console.log('  goToStop(last):');
    console.log(fmtTransition(sm.goToStop(itin.stops.length - 1)));
    console.log('  next() (past end):'); console.log(fmtTransition(sm.next()));
    console.log('  back() (from ended):'); console.log(fmtTransition(sm.back()));
    console.log('  stop():'); console.log(fmtTransition(sm.stop()));
  }

  console.log('\n  ─── Raw response candidates[0] (truncated) ───');
  const cand = itin._raw?.candidates?.[0];
  if (cand) {
    const printable = {
      finishReason: cand.finishReason,
      groundingChunksCount: cand.groundingMetadata?.groundingChunks?.length || 0,
      webSearchQueries: cand.groundingMetadata?.webSearchQueries,
      hasSearchEntryPoint: !!cand.groundingMetadata?.searchEntryPoint,
      firstChunkSample: cand.groundingMetadata?.groundingChunks?.[0],
    };
    console.log('  ' + JSON.stringify(printable, null, 2).replace(/\n/g, '\n  '));
  } else {
    console.log('  (no candidates)');
  }

  const ok = !issues.length && !!itin.stops.length;
  return { itin, ok };
}

async function exerciseMidTourQuestion(itin) {
  // Optional integration check: only runs if VITE_GOOGLE_MAPS_API_KEY is set,
  // so we can fetch a real Street View frame for identifyPlace. Otherwise it
  // skips, since we don't want to silently pass a fake frame.
  const mapsKey = process.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!mapsKey) {
    console.log('\n(skipping mid-tour question integration — VITE_GOOGLE_MAPS_API_KEY not set)');
    return true;
  }

  console.log('\n' + SEPARATOR);
  console.log('🎙  Mid-tour question integration (identifyPlace)');
  console.log(SEPARATOR);

  const sm = new TourStateMachine(itin);
  sm.start();
  console.log(`  Current stop: ${sm.currentStop.name}`);

  // Use the FIRST stop's map_query to seed coords for the synthetic question.
  // Geocode via Google Maps Geocoding API.
  const geoResp = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(sm.currentStop.map_query)}&key=${mapsKey}`,
  );
  const geo = await geoResp.json();
  if (geo.status !== 'OK' || !geo.results?.[0]) {
    console.log(`  ⚠️  Geocode failed for "${sm.currentStop.map_query}": ${geo.status}`);
    return false;
  }
  const { lat, lng } = geo.results[0].geometry.location;
  console.log(`  Geocoded to: ${lat}, ${lng}`);

  // Fetch a Street View frame at that point.
  const svResp = await fetch(
    `https://maps.googleapis.com/maps/api/streetview?size=640x640&location=${lat},${lng}&fov=80&key=${mapsKey}`,
  );
  if (!svResp.ok) {
    console.log(`  ⚠️  Street View fetch failed: HTTP ${svResp.status}`);
    return false;
  }
  const frameBase64 = Buffer.from(await svResp.arrayBuffer()).toString('base64');
  console.log(`  Got Street View frame: ${frameBase64.length} b64 chars`);

  const result = await handleMidTourQuestion(
    sm, frameBase64, lat, lng,
    'What is the most interesting thing I can see right here?',
  );

  console.log('\n  identification:');
  console.log(`    name:        ${result.identification.name ?? '(null)'}`);
  console.log(`    tier:        ${result.identification.tier}`);
  console.log(`    confidence:  ${result.identification.confidence}`);
  console.log(`    description: ${result.identification.description}`);
  console.log(`  resumeStop:   ${result.resumeStop?.name}  (current=${result.current})`);

  // Resuming did not advance current.
  if (sm.current !== 0) {
    console.log(`  ⚠️  current should still be 0, got ${sm.current}`);
    return false;
  }
  console.log('  ✅ mid-tour question did not advance the tour');
  return true;
}

async function main() {
  const customArea = process.argv[2];
  const areas = customArea ? [customArea] : ['Stanford University', 'Torres del Paine'];

  const results = [];
  for (let i = 0; i < areas.length; i++) {
    const exerciseSM = i === 0;
    const r = await runArea(areas[i], { exerciseStateMachine: exerciseSM });
    results.push({ area: areas[i], ...r });
  }

  // Mid-tour question integration runs against the first itinerary that succeeded.
  const firstOk = results.find(r => r.ok && r.itin.stops?.length);
  let midTourOk = true;
  if (firstOk) {
    try { midTourOk = await exerciseMidTourQuestion(firstOk.itin); }
    catch (e) {
      console.log(`  ⚠️  mid-tour question threw: ${e.message}`);
      midTourOk = false;
    }
  }

  console.log('\n' + SEPARATOR);
  console.log('Summary');
  console.log(SEPARATOR);
  results.forEach(r => {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.area} — ${r.itin.stops?.length ?? 0} stops`);
  });
  console.log(`  ${midTourOk ? '✅' : '❌'} mid-tour question integration`);

  const allOk = results.every(r => r.ok) && midTourOk;
  process.exit(allOk ? 0 : 1);
}

main().catch(err => {
  console.error('[smoke] Failed:', err?.stack || err);
  process.exit(1);
});
