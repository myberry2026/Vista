# SPEC: `question` intent branch — AI Tour Guide reasoning layer

## Objective
Implement the `question` intent branch. Given the current camera / street-view frame, the
user's GPS coordinates, and a transcribed spoken question (e.g. "what's that tall round
building on the left?"), return a structured, **speakable** identification of the
place/object the user is pointing at — including a short, web-grounded **background blurb**
the voice guide can narrate.

## Context (self-contained — you do not need any prior conversation)
- Product: a real-time voice tour-guide agent. A partner owns the computer-vision + 3D map
  layer; this module is the **Gemini reasoning layer**.
- This branch fires when the intent router classifies an utterance as `question` AND it has
  a visual referent ("this", "that", "the one on the left", "左边那个").
- The returned `description` is spoken aloud by Gemini Live; the user can interrupt.

## Key design decisions — DO NOT DEVIATE
1. **One fused Gemini `generateContent` call** — NOT a vision pass plus separate Maps/Search
   passes. Send the image frame AND enable BOTH Google Maps grounding (with the camera
   lat/lng) AND Google Search grounding in the same call. Rationale / division of labor:
   - **Vision** decides WHICH object the user means and describes its look.
   - **Maps grounding** (via lat/lng) supplies the authoritative IDENTITY. A chain hotel
     looks identical in every city — its identity lives in its location, not its pixels — so
     **location is the disambiguator, not vision.**
   - **Search grounding** supplies the BACKGROUND for narration (history, why it's notable,
     a fun fact). Combining Maps + Search is officially supported and Google reports it
     improves answer quality vs. either alone.
2. **Confidence tiering**, decided by the model in-prompt:
   - `landmark_vision`: famous, visually unique landmark recognized on sight → name from
     vision, confidence "high".
   - `maps_grounded`: generic building → name from the Maps-grounded nearby place that best
     matches the visual description (type, size, position).
   - `fallback_area`: no specific match / unnamed structure → **DO NOT invent a name**; give
     category + neighborhood.
3. **Enrich only when it's worth it.** Pull Search-grounded background ONLY when there is a
   confident named place (`landmark_vision` / `maps_grounded`). For `fallback_area`, skip the
   background and keep the answer to identity + area — do not pad with generic filler.
4. **Never fabricate.** No invented place names, no invented "facts" in the background. When
   unsure on identity, prefer "category + area" over a wrong name; trust Maps/Search facts
   over guesses.
5. **Do NOT force `responseSchema` / JSON mode.** Strict structured output can conflict with
   built-in grounding tools. Instead, prompt for a JSON-only response and parse it robustly
   (strip ``` fences, extract the outermost `{...}`). Provide a graceful fallback object so a
   parse failure NEVER crashes the live demo.

## Tech stack / assumptions
- Language/SDK: detect from the repo. Default JavaScript/TypeScript with `@google/genai`.
  If the repo is Python, implement with `google-genai` using equivalent types. Match existing
  repo conventions.
- Model: a configurable constant `MODEL`, default a grounding-capable model that supports
  combining built-in tools (Gemini 3 family; e.g. `gemini-3.5-flash`). If the repo already
  defines a model string, reuse it.
- Tools enabled together: `googleMaps` (with `latLng`) AND `googleSearch`.
- API key from env (`GEMINI_API_KEY`). Never hardcode; ensure it is gitignored.

## Deliverables
1. An exported `identifyPlace(frameBase64, lat, lng, userQuestion, mimeType?)` implementing
   the logic above. `frameBase64` is base64 with NO `data:` prefix; `mimeType` defaults to
   `image/jpeg`.
2. It returns the object in the Output Contract below.
3. Extraction of grounding sources from the response metadata — BOTH Maps sources
   (`groundingChunks[].maps` → `title`, `uri`) AND Search sources / Search Suggestions. The
   app must be able to display these (Google's attribution terms require showing Maps sources
   and Google Search Suggestions when grounding is used).
4. A small smoke-test script (e.g. `scripts/test-identify.mjs`) that runs `identifyPlace`
   against ONE real local image + real coordinates and prints the parsed result AND the raw
   model response. This exists specifically to verify the integration points below.

## Output contract
```json
{
  "name": "string | null",            // specific place name, or null if unknown
  "category": "string",               // "hotel", "university bell tower", "office building"
  "confidence": "high | medium | low",
  "tier": "landmark_vision | maps_grounded | fallback_area",
  "description": "2-3 sentences, SPOKEN aloud, in the USER'S language, no markdown/lists. Lead with the identity, then weave in 1-2 web-grounded background facts when tier is not fallback_area.",
  "sources": [{ "type": "maps | search", "title": "string", "uri": "string" }]
}
```

## CRITICAL — verify before assuming (these are new, fast-moving APIs)
1. **Confirm an image part + `googleMaps` + `googleSearch` can ALL coexist in a single
   `generateContent` call** on the chosen model. Prove it with the smoke test. If it errors,
   STOP and report the error instead of silently working around it (e.g. do not quietly split
   into multiple calls).
2. **Verify exact SDK field names in the INSTALLED version**, do not trust this spec's names:
   maps tool enable (expected `tools: [{ googleMaps: {} }]`), search tool enable (expected
   `tools: [{ googleSearch: {} }]` — confirm whether both go in one `tools` array), location
   (expected `toolConfig.retrievalConfig.latLng: { latitude, longitude }`), and the grounding
   metadata paths for both Maps and Search sources. Check the installed package's types /
   official docs and adjust.

## Acceptance criteria
- `identifyPlace` returns a contract-valid object for: (a) a famous-landmark image — and the
  `description` includes at least one web-grounded background fact; (b) a generic-building
  image at known coordinates; (c) an ambiguous/empty input (must degrade gracefully, never
  throw, and for unnamed structures stays identity+area with no fabricated background).
- The smoke test prints the parsed result + raw response and exits 0 on success; the raw
  response confirms both Maps and Search grounding actually fired.
- No API key in source; `.env` and `node_modules` (or venv) gitignored.
- `description` returns in the SAME language as the input question — test once with a Chinese
  question and confirm the output is Chinese.
- `tier` and `confidence` present on every response (used for on-site debugging).

## Performance note
Adding Search grounding adds a retrieval round-trip and a second or two of latency. This is
acceptable for the "point-and-ask" question branch (cover it with a spoken transition phrase
upstream). Do NOT attempt progressive "speak identity first, stream background after" in this
module — keep it a single synchronous call; progressive narration is a separate future task.

## Out of scope (do not build here)
- Intent routing, the tour state machine, Gemini Live audio wiring, map flight.
- Bearing/azimuth spatial filtering — the model reads "left/right/tallest" from the frame.
- Progressive / streamed narration.

## Optional starting point
A reference draft (`question-branch.js`) may be provided. Treat it as a starting point, not
gospel — it predates the Search-grounding addition, so add the `googleSearch` tool and the
background-narration behavior, and re-verify field names + tool coexistence per CRITICAL.
