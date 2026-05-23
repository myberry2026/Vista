# SPEC: `guided_tour` planning — AI Tour Guide reasoning layer

## Objective
Implement the `guided_tour` intent branch. Given an area spoken by the user
("give me a guided tour in Stanford", "give me a guided tour in Torres del Paine"),
produce a structured, route-ordered itinerary of 4-6 REAL, notable stops, each with
grounded narration, a geocodable map query, and an image-recognition hint — then drive a
small state machine (start / next / back / question / stop) that flies the map to each stop
and narrates it via voice.

## Context (self-contained — you do not need prior conversation)
- Product: a real-time, voice-first tour-guide agent. A partner owns the computer-vision +
  3D map layer; this module is the **Gemini reasoning layer**.
- A sibling branch already exists: `identifyPlace(...)` (the `question` branch) takes a
  camera frame + lat/lng + a spoken question and returns a structured, web-grounded
  identification. This module REUSES it for mid-tour "what's that?" questions and for
  optional per-stop live narration enrichment.
- Returned narration is spoken aloud by Gemini Live; the user can interrupt at any time.

## How this serves the hackathon themes (KEEP BOTH IN MIND WHILE BUILDING)
- **Live Agents (PRIMARY — must work):** the tour is a real-time voice agent. The user
  speaks the request, the agent narrates each stop aloud, the user interrupts with
  "next" / "back" / "stop" or asks "what's that building on the left?" mid-tour (routed to
  `identifyPlace`). Vision is used at every stop (`look_for`). Build this path rock-solid.
- **Creative Storyteller (OPTIONAL STRETCH — see bottom):** each stop can emit an
  interleaved multimodal stream — narration woven with an inline GENERATED illustration —
  using Gemini native interleaved text+image output. Gate this behind the core working.

## Key design decisions — DO NOT DEVIATE
1. **Ground the stops; do NOT let the model freely invent them.** Plan with a single fused
   Gemini `generateContent` call that enables BOTH Google Search grounding AND Google Maps
   grounding. The model must: (a) select 4-6 REAL, notable stops grounded in retrieved data,
   (b) order them into a sensible walking/visiting route, (c) write narration grounded in the
   retrieved facts (no fabrication), (d) emit per-stop `map_query`, `look_for`, `duration_sec`.
   If unsure a place is real, drop it rather than invent.
2. **Handle URBAN and NATURE areas.** Stanford → buildings/monuments; Torres del Paine →
   viewpoints, peaks, glaciers, trails. Do NOT assume stops are buildings. Each stop carries a
   `stop_type`. For natural features, identity/facts come mainly from Search grounding (a peak
   may not be a Maps POI), and `look_for` describes the natural feature ("the two granite
   towers", "the glacier face"), not a business.
3. **Plan up front, enrich live.** The planning call returns the FULL itinerary with solid
   grounded narration so there is an instant, complete, demoable tour. SEPARATELY, on arrival
   at a stop, you MAY call the existing `identifyPlace(...)` with the live camera frame to
   enrich/confirm narration against what's actually on screen. Planning ≠ live enrichment.
4. **Image recognition is used two ways:** proactively via `look_for` (tells the CV/identify
   layer what to highlight at each stop) and reactively (a mid-tour user question routes to
   `identifyPlace`).
5. **Narration language follows the user's language.** Detect from the request; write all
   narration in that language.
6. **Do NOT force `responseSchema` / JSON mode** on the grounded planning call (strict schema
   can conflict with built-in grounding tools). Prompt for JSON-only output and parse robustly
   (strip ``` fences, take the outermost `{...}`). Provide a graceful fallback so a parse
   failure never crashes the demo.

## Tech stack / assumptions
- Language/SDK: detect from repo. Default JavaScript/TypeScript with `@google/genai`
  (Python `google-genai` equivalent if the repo is Python). Match existing conventions.
- Planning model: a grounding-capable model that supports combining built-in tools
  (Gemini 3 family; e.g. `gemini-3.5-flash`). Reuse the repo's existing model constant if any.
- Tools on the planning call: `googleSearch` AND `googleMaps`.
- API key from env (`GEMINI_API_KEY`); never hardcode; ensure gitignored.

## Deliverables
1. `planTour(area, userLanguageHint?)` → returns the itinerary object (contract below),
   built from ONE fused grounded `generateContent` call.
2. A tour state machine module: holds `{ tour, current }` and exposes
   `start()`, `next()`, `back()`, `goToStop(i)`, `stop()`. Each transition returns what the
   caller should do: the `map_query` to fly to, the `narration` to speak, and the `look_for`
   hint. (State may ultimately live in the frontend — keep this module pure/portable.)
3. A `handleMidTourQuestion(frameBase64, lat, lng, question)` that delegates to the existing
   `identifyPlace(...)`, then resumes the current stop.
4. Extraction of grounding sources (Maps + Search) for display per Google's attribution terms.
5. A smoke-test script (`scripts/test-plan-tour.mjs`) that runs `planTour` for BOTH
   "Stanford" and "Torres del Paine" and prints the parsed itineraries + raw responses.

## Output contract (itinerary)
```json
{
  "intent": "guided_tour",
  "area": "string",
  "tour_title": "string (in the user's language)",
  "stops": [
    {
      "order": 1,
      "name": "string",
      "stop_type": "building | monument | viewpoint | natural_feature | district | other",
      "map_query": "string (precise, geocodable, e.g. 'Hoover Tower, Stanford University')",
      "narration": "2-3 sentences, SPOKEN aloud, in the user's language, grounded, no markdown",
      "look_for": "one concrete thing to spot/highlight in the frame at this stop",
      "duration_sec": 90
    }
  ],
  "sources": [{ "type": "maps | search", "title": "string", "uri": "string" }]
}
```

## State machine behavior
- `start()` → fly to `stops[0]`, speak its narration.
- `next()` → `current++`; if past the last stop, speak a short closing summary and end.
- `back()` → `current--` (clamp at 0).
- mid-tour question → `handleMidTourQuestion(...)` → speak the identification → return to the
  current stop (do not advance).
- `stop()` → end the tour.
- Interrupts are handled natively by Gemini Live (when the user speaks, Live stops narrating
  and responds); this module just needs clean, idempotent transitions so resuming is correct.

## CRITICAL — verify before assuming (new, fast-moving APIs)
1. Confirm `googleSearch` + `googleMaps` can both be enabled in one `generateContent` call on
   the chosen model (prove via smoke test; if it errors, STOP and report).
2. Verify exact SDK field names in the INSTALLED version (tool enable arrays, grounding
   metadata paths). Do not trust this spec's field names.
3. Confirm the Torres del Paine run actually returns natural-feature stops with sensible
   `look_for` values (this is the non-urban correctness check).

## Acceptance criteria
- `planTour("Stanford University")` and `planTour("Torres del Paine")` each return a
  contract-valid itinerary with 4-6 real stops, a sensible order, and `map_query` values that
  would geocode.
- No fabricated stops or facts; narration is grounded.
- `stop_type` and `look_for` are appropriate to each area (buildings for Stanford, natural
  features for Torres del Paine).
- State machine `start`/`next`/`back`/`stop` behave correctly, including end-of-tour summary.
- A mid-tour question delegates to `identifyPlace` and resumes the current stop.
- All narration is in the user's language (test once with a Chinese request).
- Smoke test prints both itineraries + raw responses and exits 0.

## OPTIONAL STRETCH — Creative Storyteller layer (only after core works)
Add `narrateStopWithVisual(stop)` that uses Gemini native interleaved text+image output
(model e.g. `gemini-3.1-flash-image-preview` / `gemini-3-pro-image-preview`, response
modalities TEXT + IMAGE) to produce, for a single stop, an interleaved stream of narration +
ONE inline generated illustration (e.g. an architectural close-up, a historical "what it
looked like in <year>" render, or a labeled diagram). Iterate the response's content blocks
(do NOT rely on a single `.output_text`/`.output_image` convenience — interleaved output is
multi-block). Requirements/guards:
- This is a SEPARATE call from `planTour` (different model). Do not block the core tour on it.
- Generate the visual lazily on stop arrival, behind a feature flag, with a timeout +
  fallback to plain narration if it's slow or fails.
- Keep generated images clearly illustrative, never presented as real photos of the place.
- This is what lets the project credibly claim BOTH hackathon themes.

## Out of scope
- Intent routing (separate branch), Gemini Live audio wiring, map rendering/flight.
- True geographic route optimization (model-ordered route is sufficient).
- Bearing/azimuth spatial filtering.
