/**
 * Guided-tour planning + state machine — v0 (no grounding, no identify).
 *
 * - planTour(area)     → one generateContent call with responseSchema,
 *                        returns a 4-6 stop itinerary
 * - TourStateMachine   → pure start/next/back/goTo/stop
 *
 * Grounding (Search + Maps) and the mid-tour identify hand-off are intentionally
 * out of scope here; this is the minimum needed to wire up
 * planner → state machine → UI → Live narration end-to-end.
 */

import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import fs from 'fs';

if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
}

export const PLANNING_MODEL = 'gemini-2.5-flash';

const MIN_STOPS = 4;
const MAX_STOPS = 6;
const DEFAULT_STOP_DURATION_SEC = 90;
const STOP_TYPES = ['building', 'monument', 'viewpoint', 'natural_feature', 'district', 'other'];

const PLANNING_SYSTEM_INSTRUCTION = `You are the planning layer of a real-time voice tour-guide agent.

You receive an "area" the user wants a guided tour of (a campus, neighborhood,
city, national park, or stretch of landscape).

Produce a route-ordered itinerary of ${MIN_STOPS}-${MAX_STOPS} REAL, notable
stops in that area. The itinerary is spoken aloud and used to fly a map between
stops.

# Rules
- Pick REAL, well-known stops. If unsure a place is real or correctly located,
  drop it. Better to return ${MIN_STOPS} solid stops than ${MAX_STOPS} with a
  made-up one.
- Order stops into a sensible walking/visiting route — no zig-zag.
- Handle both urban and nature areas:
  - Urban (Stanford, Manhattan, Kyoto): mostly buildings, monuments, museums,
    plazas.
  - Nature (Torres del Paine, Yosemite, Banff): viewpoints, peaks, glaciers,
    lakes, trails. Use stop_type = "natural_feature" or "viewpoint" for these.
- "narration": 2-3 sentences, English, written to be spoken aloud — no
  markdown, no lists, no URLs, no parentheticals the TTS would stumble on.
  Lead with the name, then 1-2 facts.
- "map_query": a precise, geocodable string. Prefer "Place Name, Parent"
  ("Hoover Tower, Stanford University"; "Mirador Las Torres, Torres del Paine
  National Park"). Will be passed to a geocoder.
- "look_for": ONE concrete visual cue to highlight at this stop ("the red
  sandstone clock tower", "the two granite spires above the lake").
- "duration_sec": typical 60-120 seconds.
- "order" is 1-indexed and contiguous.`;

const ITINERARY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    area: { type: Type.STRING },
    tour_title: { type: Type.STRING },
    stops: {
      type: Type.ARRAY,
      minItems: MIN_STOPS,
      maxItems: MAX_STOPS,
      items: {
        type: Type.OBJECT,
        properties: {
          order: { type: Type.INTEGER },
          name: { type: Type.STRING },
          stop_type: { type: Type.STRING, enum: STOP_TYPES },
          map_query: { type: Type.STRING },
          narration: { type: Type.STRING },
          look_for: { type: Type.STRING },
          duration_sec: { type: Type.INTEGER },
        },
        required: ['order', 'name', 'stop_type', 'map_query', 'narration', 'look_for', 'duration_sec'],
        propertyOrdering: ['order', 'name', 'stop_type', 'map_query', 'narration', 'look_for', 'duration_sec'],
      },
    },
  },
  required: ['area', 'tour_title', 'stops'],
  propertyOrdering: ['area', 'tour_title', 'stops'],
};

const CLOSING_SUMMARY_FALLBACK =
  "That wraps up our tour. Hope you enjoyed the stops — let me know if you want to revisit any of them or start a new tour.";

function emptyItinerary(area, reason) {
  return {
    intent: 'guided_tour',
    area: area || '',
    tour_title: '',
    stops: [],
    error: reason || 'unknown',
  };
}

/**
 * Coerce/validate raw model output into the public itinerary contract.
 * Drops malformed stops, re-indexes order, fills sane defaults. Never throws.
 */
function normaliseItinerary(parsed, area) {
  if (!parsed || typeof parsed !== 'object') {
    return emptyItinerary(area, 'parse_failed');
  }
  const allowedTypes = new Set(STOP_TYPES);

  const stopsIn = Array.isArray(parsed.stops) ? parsed.stops : [];
  const stops = [];
  for (const s of stopsIn) {
    if (!s || typeof s !== 'object') continue;
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    const narration = typeof s.narration === 'string' ? s.narration.trim() : '';
    const mapQuery = typeof s.map_query === 'string' ? s.map_query.trim() : '';
    if (!name || !narration || !mapQuery) continue;

    const stop_type = allowedTypes.has(s.stop_type) ? s.stop_type : 'other';
    const look_for = typeof s.look_for === 'string' && s.look_for.trim()
      ? s.look_for.trim() : name;
    const duration_sec = Number.isFinite(s.duration_sec) && s.duration_sec > 0
      ? Math.round(s.duration_sec) : DEFAULT_STOP_DURATION_SEC;

    stops.push({
      order: stops.length + 1,
      name,
      stop_type,
      map_query: mapQuery,
      narration,
      look_for,
      duration_sec,
    });
    if (stops.length >= MAX_STOPS) break;
  }

  const finalArea = (typeof parsed.area === 'string' && parsed.area.trim()) || area || '';
  const tour_title = (typeof parsed.tour_title === 'string' && parsed.tour_title.trim())
    || (finalArea ? `A Guided Tour of ${finalArea}` : 'A Guided Tour');

  return { intent: 'guided_tour', area: finalArea, tour_title, stops };
}

/**
 * Plan a guided tour for the given area.
 *
 * @param {string} area
 * @param {{ model?: string, client?: GoogleGenAI, debug?: boolean }} [options]
 */
export async function planTour(area, options = {}) {
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
              `Return ${MIN_STOPS}-${MAX_STOPS} real, notable stops in a sensible route order.`,
          },
        ],
      },
    ],
    config: {
      systemInstruction: { parts: [{ text: PLANNING_SYSTEM_INSTRUCTION }] },
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: ITINERARY_SCHEMA,
    },
  };

  let response;
  try {
    response = await ai.models.generateContent(request);
  } catch (err) {
    console.error('[tour-planning] generateContent failed:', err?.message || err);
    return emptyItinerary(cleaned, `api_error: ${err?.message || err}`);
  }

  const text = response?.text ?? '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    return { ...emptyItinerary(cleaned, 'parse_failed'), ...(options.debug ? { _raw: response, _debug: { modelText: text, model } } : {}) };
  }
  const itinerary = normaliseItinerary(parsed, cleaned);

  if (options.debug) {
    itinerary._debug = { modelText: text, model };
    itinerary._raw = response;
  }
  return itinerary;
}

/**
 * Pure tour state machine. Holds `{ tour, current }` and exposes transition
 * methods. Each transition returns the action the caller should take (fly
 * map to a query, speak narration, highlight a thing).
 */
export class TourStateMachine {
  constructor(tour) {
    if (!tour || !Array.isArray(tour.stops) || tour.stops.length === 0) {
      throw new Error('TourStateMachine: tour must have at least one stop');
    }
    this.tour = tour;
    /** -1 = not started, 0..n-1 = active, n = ended */
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
      this.current = 0;
      return this._transitionFor('rewound');
    }
    if (this.current >= this.tour.stops.length) {
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
    this.current = this.tour.stops.length;
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
