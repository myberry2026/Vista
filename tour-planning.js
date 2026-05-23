/**
 * Guided-tour planning + state machine.
 *
 * - planTour(area)              → one fused, grounded generateContent call
 *                                 returns a 4-6 stop itinerary
 * - TourStateMachine            → pure, portable start/next/back/goTo/stop
 * - handleMidTourQuestion(...)  → delegates to identifyPlace and returns
 *                                 enough info for the caller to resume
 *
 * See specs/SPEC-2-guided-tour-planning.md for the full design rationale.
 */

import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import fs from 'fs';
import {
  MODEL,
  identifyPlace,
  extractGroundingSources,
  parseModelJson,
} from './question-branch.js';

if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
}

// Reuse the question-branch default. Both calls need grounding-capable models
// that support combining googleSearch + googleMaps in one request.
export const PLANNING_MODEL = MODEL;

const MIN_STOPS = 4;
const MAX_STOPS = 6;
const DEFAULT_STOP_DURATION_SEC = 90;

const PLANNING_SYSTEM_INSTRUCTION = `You are the planning layer of a real-time voice tour-guide agent.

You receive: an "area" the user wants a guided tour of (anything from a university
campus, a neighborhood, or a city, to a national park or a stretch of natural
landscape).

Your job is to produce a route-ordered itinerary of ${MIN_STOPS}-${MAX_STOPS}
REAL, notable stops in that area, grounded in retrieved data. The itinerary is
spoken aloud and used to fly a map between stops.

# Use the tools — DO NOT freely invent stops
Use Google Search grounding and Google Maps grounding to:
- find notable places, viewpoints, landmarks, or natural features in the area;
- order them into a sensible walking/visiting route (no zig-zag);
- gather 1-2 grounded facts per stop for narration.
If you are unsure a place is real or correctly located, DROP IT rather than
invent. Better to return 4 solid stops than 6 with one made-up one.

# Handle URBAN and NATURE areas
- Urban (Stanford, Manhattan, Kyoto): stops are mostly buildings, monuments,
  museums, plazas. Maps grounding usually has them.
- Nature (Torres del Paine, Yosemite, Banff): stops are viewpoints, peaks,
  glaciers, lakes, trails. A peak may NOT be a Maps POI — its identity/facts
  come mainly from Search grounding. That is expected and fine.
Set stop_type from: building | monument | viewpoint | natural_feature | district | other.

# Output rules
- ALWAYS RESPOND IN ENGLISH. This demo is for an English-speaking audience.
  Even if the area is named in another language (e.g. "Torres del Paine"), write
  the narration in English. You may keep proper nouns in their native form.
- "narration" is 2-3 sentences, written to be spoken aloud (no markdown, no
  lists, no URLs, no parentheticals the TTS would stumble on). Lead with the
  name, then weave in 1-2 grounded facts.
- "map_query" is a precise, geocodable string. For Maps-listed places, prefer
  the full place name + parent ("Hoover Tower, Stanford University"). For
  natural features, include the park/region ("Mirador Las Torres, Torres del
  Paine National Park"). It will be passed to a geocoder.
- "look_for" is ONE concrete visual cue to highlight for the user at this stop
  ("the red sandstone clock tower", "the two granite spires above the lake").
  This drives the vision/identify layer.
- "duration_sec" is suggested narration+lingering time in seconds, typically
  60-120.

# Output format
Return a SINGLE JSON object, nothing else. No prose, no markdown fences, no
explanation. Match this exact shape:

{
  "intent": "guided_tour",
  "area": "<echo the area as the user said it>",
  "tour_title": "<short English title for the tour>",
  "stops": [
    {
      "order": 1,
      "name": "<place name>",
      "stop_type": "<one of: building | monument | viewpoint | natural_feature | district | other>",
      "map_query": "<geocodable string>",
      "narration": "<2-3 spoken English sentences, grounded>",
      "look_for": "<one concrete visual cue>",
      "duration_sec": 90
    }
  ]
}

Constraints:
- ${MIN_STOPS} <= stops.length <= ${MAX_STOPS}.
- stops[i].order = i+1 (1-indexed, contiguous).
- No fabricated stops. No fabricated facts in narration.`;

const CLOSING_SUMMARY_FALLBACK =
  "That wraps up our tour. Hope you enjoyed the stops — let me know if you want to revisit any of them or start a new tour.";

function emptyItinerary(area, reason) {
  return {
    intent: 'guided_tour',
    area: area || '',
    tour_title: '',
    stops: [],
    sources: [],
    error: reason || 'unknown',
  };
}

/**
 * Coerce/validate raw model output into the public itinerary contract.
 * Drops malformed stops, clamps order, fills sane defaults. Never throws.
 */
function normaliseItinerary(parsed, area, sources) {
  if (!parsed || typeof parsed !== 'object') {
    return { ...emptyItinerary(area, 'parse_failed'), sources };
  }
  const allowedTypes = new Set([
    'building', 'monument', 'viewpoint', 'natural_feature', 'district', 'other',
  ]);

  const stopsIn = Array.isArray(parsed.stops) ? parsed.stops : [];
  const stops = [];
  for (const s of stopsIn) {
    if (!s || typeof s !== 'object') continue;
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    const narration = typeof s.narration === 'string' ? s.narration.trim() : '';
    const mapQuery = typeof s.map_query === 'string' ? s.map_query.trim() : '';
    if (!name || !narration || !mapQuery) continue; // drop unusable stops

    const stop_type = allowedTypes.has(s.stop_type) ? s.stop_type : 'other';
    const look_for = typeof s.look_for === 'string' && s.look_for.trim()
      ? s.look_for.trim() : name;
    const duration_sec = Number.isFinite(s.duration_sec) && s.duration_sec > 0
      ? Math.round(s.duration_sec) : DEFAULT_STOP_DURATION_SEC;

    stops.push({
      order: stops.length + 1, // re-index 1..N regardless of model's numbering
      name,
      stop_type,
      map_query: mapQuery,
      narration,
      look_for,
      duration_sec,
    });
    if (stops.length >= MAX_STOPS) break;
  }

  const intent = 'guided_tour';
  const finalArea = (typeof parsed.area === 'string' && parsed.area.trim()) || area || '';
  const tour_title = (typeof parsed.tour_title === 'string' && parsed.tour_title.trim())
    || (finalArea ? `A Guided Tour of ${finalArea}` : 'A Guided Tour');

  return { intent, area: finalArea, tour_title, stops, sources };
}

/**
 * Plan a guided tour for the given area.
 *
 * @param {string} area
 * @param {string} [_userLanguageHint] - Accepted for spec compatibility but
 *   ignored: narration is locked to English for this hackathon. See
 *   PLANNING_SYSTEM_INSTRUCTION.
 * @param {{ model?: string, client?: GoogleGenAI, debug?: boolean }} [options]
 * @returns {Promise<{
 *   intent: 'guided_tour',
 *   area: string,
 *   tour_title: string,
 *   stops: Array<{
 *     order: number, name: string, stop_type: string,
 *     map_query: string, narration: string, look_for: string,
 *     duration_sec: number,
 *   }>,
 *   sources: Array<{type:'maps'|'search', title:string, uri:string}>,
 *   _debug?: object,
 *   _raw?: object,
 *   error?: string,
 * }>}
 */
export async function planTour(area, _userLanguageHint, options = {}) {
  const cleaned = (area || '').trim();
  if (!cleaned) return emptyItinerary('', 'empty_area');

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey && !options.client) throw new Error('GEMINI_API_KEY is not set');

  const ai = options.client || new GoogleGenAI({ apiKey });
  const model = options.model || PLANNING_MODEL;

  const request = {
    model,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              `Plan a guided tour of: "${cleaned}".\n\n` +
              `Return ${MIN_STOPS}-${MAX_STOPS} real, notable stops in a sensible route ` +
              `order, with grounded English narration. Output the JSON object specified ` +
              `in the system instructions and NOTHING ELSE.`,
          },
        ],
      },
    ],
    config: {
      systemInstruction: { parts: [{ text: PLANNING_SYSTEM_INSTRUCTION }] },
      temperature: 0.3,
      // Both grounding tools in one call — verified against @google/genai 1.52
      // (Tool interface has googleMaps and googleSearch as sibling optional fields).
      tools: [
        { googleMaps: {} },
        { googleSearch: {} },
      ],
      // No retrievalConfig.latLng: tours are area-based, not point-based. Maps
      // grounding resolves the area from the search context.
    },
  };

  let response;
  try {
    response = await ai.models.generateContent(request);
  } catch (err) {
    console.error('[tour-planning] generateContent failed:', err?.message || err);
    return emptyItinerary(cleaned, `api_error: ${err?.message || err}`);
  }

  const { sources, debug } = extractGroundingSources(response);
  const text = response?.text ?? '';
  const parsed = parseModelJson(text);
  const itinerary = normaliseItinerary(parsed, cleaned, sources);

  if (options.debug) {
    itinerary._debug = { ...debug, modelText: text, model };
    itinerary._raw = response;
  }
  return itinerary;
}

/**
 * Pure, portable tour state machine. Holds `{ tour, current }` and exposes
 * transition methods. Each transition returns the action the caller should
 * take (fly map to a query, speak narration, highlight a thing).
 *
 * Pure: no network, no React, no DOM. Safe to instantiate on either side.
 */
export class TourStateMachine {
  constructor(tour) {
    if (!tour || !Array.isArray(tour.stops) || tour.stops.length === 0) {
      throw new Error('TourStateMachine: tour must have at least one stop');
    }
    /** @type {object} */
    this.tour = tour;
    /** @type {number} -1 = not started, 0..n-1 = active, n = ended */
    this.current = -1;
  }

  get currentStop() {
    if (this.current < 0 || this.current >= this.tour.stops.length) return null;
    return this.tour.stops[this.current];
  }

  get isStarted() {
    return this.current >= 0 && this.current < this.tour.stops.length;
  }

  get isEnded() {
    return this.current >= this.tour.stops.length;
  }

  _transitionFor(type) {
    const stop = this.currentStop;
    if (!stop) {
      return {
        type,
        done: true,
        current: null,
        stop: null,
        map_query: null,
        narration: this._closingSummary(),
        look_for: null,
      };
    }
    return {
      type,
      done: false,
      current: this.current,
      stop,
      map_query: stop.map_query,
      narration: stop.narration,
      look_for: stop.look_for,
    };
  }

  _closingSummary() {
    const title = this.tour.tour_title || `our tour of ${this.tour.area || 'this area'}`;
    const last = this.tour.stops[this.tour.stops.length - 1];
    if (!last) return CLOSING_SUMMARY_FALLBACK;
    return `That brings us to the end of ${title}. We finished at ${last.name}. ` +
      `Say "back" to revisit a stop, or ask me a question about anything you saw.`;
  }

  start() {
    this.current = 0;
    return this._transitionFor('started');
  }

  next() {
    if (this.current < 0) return this.start();
    this.current = Math.min(this.current + 1, this.tour.stops.length);
    if (this.current >= this.tour.stops.length) {
      return this._transitionFor('ended');
    }
    return this._transitionFor('advanced');
  }

  back() {
    if (this.current <= 0) {
      // Already at first stop (or before): re-emit stop 0 rather than going negative.
      this.current = 0;
      return this._transitionFor('rewound');
    }
    if (this.current >= this.tour.stops.length) {
      // Coming back from "ended" lands on the last stop.
      this.current = this.tour.stops.length - 1;
      return this._transitionFor('rewound');
    }
    this.current -= 1;
    return this._transitionFor('rewound');
  }

  goToStop(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this.tour.stops.length) {
      throw new RangeError(`goToStop: index ${i} out of range [0, ${this.tour.stops.length - 1}]`);
    }
    this.current = i;
    return this._transitionFor('jumped');
  }

  stop() {
    const wasOn = this.currentStop;
    this.current = this.tour.stops.length; // mark ended
    return {
      type: 'stopped',
      done: true,
      current: null,
      stop: null,
      map_query: null,
      narration: wasOn
        ? `Tour stopped. We left off at ${wasOn.name}. Say "start tour" when you want to begin again.`
        : 'Tour stopped before it began.',
      look_for: null,
    };
  }
}

/**
 * Handle a mid-tour user question by delegating to identifyPlace. The caller
 * is expected to speak `identification.description`, then refocus on
 * `resumeStop` (no advance). Pure wrapper — no state mutation.
 *
 * @param {TourStateMachine} sm
 * @param {string} frameBase64
 * @param {number} lat
 * @param {number} lng
 * @param {string} question
 * @param {string} [mimeType]
 * @param {object} [options] - passthrough to identifyPlace
 */
export async function handleMidTourQuestion(sm, frameBase64, lat, lng, question, mimeType, options) {
  if (!(sm instanceof TourStateMachine)) {
    throw new TypeError('handleMidTourQuestion: first arg must be a TourStateMachine');
  }
  const identification = await identifyPlace(frameBase64, lat, lng, question, mimeType, options);
  return {
    type: 'mid_tour_question',
    identification,
    current: sm.current,
    resumeStop: sm.currentStop, // may be null if user asked before start()
  };
}
