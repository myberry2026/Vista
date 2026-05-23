/**
 * Question-intent branch: identify what the user is asking about based on the
 * current Street View frame + GPS, and produce a speakable identification +
 * background blurb.
 *
 * One fused generateContent call with image + googleMaps(latLng) + googleSearch.
 * See specs/SPEC-1-question-branch.md for the full design rationale.
 */

import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import fs from 'fs';

if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
}

// Grounding-capable model that supports combining built-in tools.
// Override per call via the `model` option if needed.
export const MODEL = 'gemini-2.5-pro';

const SYSTEM_INSTRUCTION = `You are the reasoning layer of a real-time voice tour-guide agent.
The user is standing somewhere and asking a spoken question about what they see
in the attached camera frame (e.g. "what's that tall round building on the left?").
You receive: the frame, the user's GPS lat/lng, and the transcribed question.

Your job is to identify the specific place/object the user is pointing at and
produce a short, SPOKEN answer for the voice guide to read aloud.

Division of labor:
- VISION decides WHICH object the user means (handles "left/right/tallest/the one
  with the dome") and describes how it looks.
- GOOGLE MAPS GROUNDING (with the provided lat/lng) supplies the authoritative
  IDENTITY. A chain hotel looks identical in every city — its identity lives in
  its location, not its pixels. Trust the Maps-grounded place names over visual
  guesses for non-famous structures.
- GOOGLE SEARCH GROUNDING supplies BACKGROUND for narration (history, why it's
  notable, a fun fact). Use it only when you have a confident named place.

Pick exactly one of three tiers:
- "landmark_vision": a famous, visually unique landmark you recognise on sight
  (Eiffel Tower, Big Ben, the Colosseum). confidence = "high". name from vision.
- "maps_grounded": a generic building/business that you can match to a nearby
  Maps place by type/size/position. name from Maps grounding. confidence =
  "high" or "medium".
- "fallback_area": no specific match, or the question has no visual referent, or
  the image is blank/ambiguous. DO NOT INVENT A NAME. Return name=null and give
  category + neighborhood only. confidence = "low".

Enrichment rule: pull a 1-2 sentence web-grounded background fact ONLY for
landmark_vision and maps_grounded tiers. For fallback_area, keep the answer to
identity + area — do not pad with generic filler.

Never fabricate place names or facts. When unsure, prefer "category + area" over
a wrong name. Prefer Maps/Search facts over guesses.

Output: a single JSON object, nothing else. No prose, no markdown fences, no
explanation. The JSON must match this exact shape:

{
  "name": string | null,
  "category": string,
  "confidence": "high" | "medium" | "low",
  "tier": "landmark_vision" | "maps_grounded" | "fallback_area",
  "description": string
}

Rules for "description":
- 2-3 sentences, written to be spoken aloud (no markdown, no lists, no URLs, no
  parentheticals the TTS would stumble on).
- ALWAYS RESPOND IN ENGLISH, regardless of the language of the user's question.
  This demo is for an English-speaking audience. If the user asks in Chinese,
  Japanese, Spanish, etc., understand the question but still answer in English.
- Lead with the identity ("That's ..."), then 1-2 background facts if the tier
  permits.
- For fallback_area, identify the category + area and stop. Do not invent.`;

/**
 * Extract a JSON object from a string that may have ``` fences, leading prose,
 * trailing prose, etc. Returns null if no valid JSON object is found.
 */
export function parseModelJson(text) {
  if (!text || typeof text !== 'string') return null;

  // Strip ```json / ``` fences if present.
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // First try: parse the whole thing.
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}

  // Second try: extract the outermost { ... } block by depth counting (so
  // strings containing braces don't confuse us — basic but works for the
  // model's typical output).
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const block = cleaned.slice(start, i + 1);
        try {
          const parsed = JSON.parse(block);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch {}
      }
    }
  }
  return null;
}

/**
 * Pull both Maps and Search grounding sources out of the response metadata.
 * Also returns the Search Suggestions rendered HTML (required for attribution
 * when Google Search grounding is used) and the search queries.
 */
export function extractGroundingSources(response) {
  const candidate = response?.candidates?.[0];
  const meta = candidate?.groundingMetadata;
  const sources = [];
  const debug = {
    mapsChunkCount: 0,
    webChunkCount: 0,
    searchQueries: [],
    searchSuggestionsHtml: null,
    widgetContextToken: null,
  };
  if (!meta) return { sources, debug };

  for (const chunk of meta.groundingChunks || []) {
    if (chunk.maps && (chunk.maps.title || chunk.maps.uri)) {
      sources.push({
        type: 'maps',
        title: chunk.maps.title || '',
        uri: chunk.maps.uri || '',
      });
      debug.mapsChunkCount++;
    }
    if (chunk.web && (chunk.web.title || chunk.web.uri)) {
      sources.push({
        type: 'search',
        title: chunk.web.title || '',
        uri: chunk.web.uri || '',
      });
      debug.webChunkCount++;
    }
  }

  if (Array.isArray(meta.webSearchQueries)) debug.searchQueries = meta.webSearchQueries;
  if (meta.searchEntryPoint?.renderedContent) debug.searchSuggestionsHtml = meta.searchEntryPoint.renderedContent;
  if (meta.googleMapsWidgetContextToken) debug.widgetContextToken = meta.googleMapsWidgetContextToken;

  return { sources, debug };
}

/**
 * Graceful fallback when parsing or the API itself fails. The voice guide
 * should still say something coherent rather than crashing the live demo.
 */
function fallbackResult(message) {
  return {
    name: null,
    category: 'unknown',
    confidence: 'low',
    tier: 'fallback_area',
    description: message || "I'm not sure what's in view right now. Let's take a closer look together.",
    sources: [],
  };
}

/**
 * Coerce/validate model output into the public contract shape. Drops unexpected
 * fields, normalises enums, and falls back to safe defaults for missing pieces.
 */
function normaliseResult(parsed, sources) {
  if (!parsed) return { ...fallbackResult('Sorry, I could not get a clear answer on that one.'), sources };

  const allowedTiers = new Set(['landmark_vision', 'maps_grounded', 'fallback_area']);
  const allowedConfidence = new Set(['high', 'medium', 'low']);

  const tier = allowedTiers.has(parsed.tier) ? parsed.tier : 'fallback_area';
  const confidence = allowedConfidence.has(parsed.confidence) ? parsed.confidence : 'low';
  const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null;
  const category = typeof parsed.category === 'string' && parsed.category.trim()
    ? parsed.category.trim()
    : 'unknown';
  const description = typeof parsed.description === 'string' && parsed.description.trim()
    ? parsed.description.trim()
    : "I can see something in front of you, but I cannot pin down the details right now.";

  return { name, category, confidence, tier, description, sources };
}

/**
 * Identify the place/object the user is asking about.
 *
 * @param {string} frameBase64 - Base64 image (NO `data:` prefix).
 * @param {number} lat - Latitude in degrees.
 * @param {number} lng - Longitude in degrees.
 * @param {string} userQuestion - Transcribed user utterance.
 * @param {string} [mimeType='image/jpeg']
 * @param {{ model?: string, client?: GoogleGenAI, debug?: boolean }} [options]
 * @returns {Promise<{
 *   name: string|null,
 *   category: string,
 *   confidence: 'high'|'medium'|'low',
 *   tier: 'landmark_vision'|'maps_grounded'|'fallback_area',
 *   description: string,
 *   sources: Array<{type: 'maps'|'search', title: string, uri: string}>,
 *   _debug?: object,
 *   _raw?: object,
 * }>}
 */
export async function identifyPlace(
  frameBase64,
  lat,
  lng,
  userQuestion,
  mimeType = 'image/jpeg',
  options = {},
) {
  const question = (userQuestion || '').trim();
  if (!frameBase64 || !question || typeof lat !== 'number' || typeof lng !== 'number') {
    return fallbackResult("I need a picture, your location, and a question to help with that.");
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey && !options.client) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  const ai = options.client || new GoogleGenAI({ apiKey });
  const model = options.model || MODEL;

  // ONE fused call with image + Maps grounding + Search grounding.
  // Both tools live in the same `tools` array; latLng goes into
  // toolConfig.retrievalConfig (verified against @google/genai 1.52 types).
  const request = {
    model,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { data: frameBase64, mimeType } },
          {
            text:
              `User GPS: lat=${lat}, lng=${lng}\n` +
              `User question (answer in this same language): "${question}"\n\n` +
              `Identify the specific place or object the user is asking about and return the JSON object described in the system instructions.`,
          },
        ],
      },
    ],
    config: {
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      // No responseSchema / responseMimeType: strict JSON mode can conflict
      // with built-in grounding tools. We parse the JSON robustly below.
      temperature: 0.2,
      tools: [
        { googleMaps: {} },
        { googleSearch: {} },
      ],
      toolConfig: {
        retrievalConfig: {
          latLng: { latitude: lat, longitude: lng },
        },
      },
    },
  };

  let response;
  try {
    response = await ai.models.generateContent(request);
  } catch (err) {
    console.error('[question-branch] generateContent failed:', err?.message || err);
    return fallbackResult("Sorry, I had trouble reaching the guide service just now.");
  }

  const { sources, debug } = extractGroundingSources(response);
  const text = response?.text ?? '';
  const parsed = parseModelJson(text);
  const result = normaliseResult(parsed, sources);

  if (options.debug) {
    result._debug = { ...debug, modelText: text, model };
    result._raw = response;
  }

  return result;
}
