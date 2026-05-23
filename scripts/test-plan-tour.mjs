#!/usr/bin/env node
/**
 * Smoke test for tour-planning v0: planTour + state machine.
 *
 * Usage:
 *   node scripts/test-plan-tour.mjs            # runs Stanford + Torres del Paine
 *   node scripts/test-plan-tour.mjs "Kyoto"    # plans one custom area
 *
 * Requires GEMINI_API_KEY in .env.local. Exits 0 on success, 1 on failure.
 */

import { planTour, TourStateMachine } from '../tour-planning.js';

const SEPARATOR = '═'.repeat(72);

function fmtStop(stop, indent = '  ') {
  return [
    `${indent}#${stop.order} ${stop.name}  [${stop.stop_type}, ${stop.duration_sec}s]`,
    `${indent}  map_query: ${stop.map_query}`,
    `${indent}  look_for:  ${stop.look_for}`,
    `${indent}  narration: ${stop.narration}`,
  ].join('\n');
}

function fmtTransition(t) {
  if (t.done) return `  done=true | narration: ${t.narration}`;
  return `  current=${t.current} (${t.stop.name}) | map_query="${t.map_query}" | look_for="${t.look_for}"`;
}

function validateItinerary(itin) {
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
  const itin = await planTour(area, { debug: true });
  const ms = Date.now() - t0;

  if (itin.error) {
    console.log(`  ❌ planTour returned error: ${itin.error}`);
    return { itin, ok: false };
  }

  console.log(`  Title: ${itin.tour_title}`);
  console.log(`  Area:  ${itin.area}`);
  console.log(`  Stops: ${itin.stops.length}  (elapsed: ${ms} ms)\n`);
  itin.stops.forEach(s => console.log(fmtStop(s) + '\n'));

  const issues = validateItinerary(itin);
  if (issues.length) {
    console.log('  ⚠️  Contract issues:');
    issues.forEach(x => console.log(`    - ${x}`));
  } else {
    console.log('  ✅ Contract OK');
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

  const ok = !issues.length && !!itin.stops.length;
  return { itin, ok };
}

async function main() {
  const customArea = process.argv[2];
  const areas = customArea ? [customArea] : ['Stanford University', 'Torres del Paine'];

  const results = [];
  for (let i = 0; i < areas.length; i++) {
    const r = await runArea(areas[i], { exerciseStateMachine: i === 0 });
    results.push({ area: areas[i], ...r });
  }

  console.log('\n' + SEPARATOR);
  console.log('Summary');
  console.log(SEPARATOR);
  results.forEach(r => {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.area} — ${r.itin.stops?.length ?? 0} stops`);
  });

  process.exit(results.every(r => r.ok) ? 0 : 1);
}

main().catch(err => {
  console.error('[smoke] Failed:', err?.stack || err);
  process.exit(1);
});
