# Vista — Claude Code Notes

Vista is a real-time AI virtual tour guide: the browser captures the user's microphone + Google Street View frames and streams them to the Gemini Live API through a Node WebSocket proxy. The model talks back with audio + transcripts and can drive the Street View camera via tool calls.

Tagline: *"Roam the world from your screen."*

## Architecture at a glance

```
Browser (React 19 + Vite)                  Node server                   Google Cloud
─────────────────────────                  ────────────────              ─────────────
  src/App.tsx                              vite.config.ts (dev)
   ├─ mic → AudioWorklet (PCM 16k) ─┐      └─ devPlugin attaches  ──┐
   ├─ Street View static frames  ───┼──►   gemini-ws.js  ──ws──────►│  Gemini Live API
   ├─ WebSocket /api/live ──────────┘      (WebSocketServer)        │  (gemini-2.5-flash-
   ├─ plays 24k PCM audio                  ▲                        │   native-audio-preview)
   └─ executes navigate/teleport tools ────┘ client_tool_request    │
                                                                    │
  src/components/StreetWalkPanorama.tsx                              │  Google Maps JS API
  src/lib/map_tools.ts                                               │  (Street View + Geocoder)
                                            index.js (prod)  ────────┘
                                            └─ serves dist/ + same WS
```

**Two run modes share the same WS proxy code:**
- **Dev**: `npm run dev` — Vite serves the SPA *and* attaches `gemini-ws.js` via a custom plugin in `vite.config.ts:12-33`. One process, port 3000.
- **Prod**: `npm start` (`node index.js`) — Express serves built `dist/` and the WS proxy. Port 8080. This is what the Dockerfile/Cloud Run uses.

You normally don't need to run `index.js` locally — `npm run dev` covers everything.

## Key files

| File | What it does |
|---|---|
| `src/App.tsx` | The whole app. Connection lifecycle, mic→PCM pipeline, 24k PCM playback, transcript state, reconnect logic, auto-chat silence detection, manual nav buttons. ~1300 lines, single component. |
| `src/components/StreetWalkPanorama.tsx` | Mounts the Google Street View panorama. Exposes the panorama instance on `window._vistaStreetWalkContext.panorama` so `App.tsx` can drive it. |
| `src/lib/map_tools.ts` | `handleNavigate` (left/right/forward/backward/around), `handleTeleport` (geocode → Street View lookup), `resolveMapsApiKey` (build-time → cached → `/api/config` fallback). |
| `src/config.ts` | Centralised tunables: audio rates, video frame size/interval, reconnect backoff, context-window compression thresholds. **No env vars** — edit the constants. |
| `src/utils.ts` | `uint8ArrayToBase64`, `getReconnectDelayMs` (exponential backoff, capped at 10s). |
| `gemini-ws.js` | WebSocket proxy. Owns the Gemini Live SDK session, declares the `navigate` + `teleport` tools, holds the system instruction, enforces origin allow-list. |
| `index.js` | Production Express server. Serves `dist/`, exposes `GET /api/config` (returns `VITE_GOOGLE_MAPS_API_KEY` at runtime), attaches the WS proxy. |
| `vite.config.ts` | Dev server with the WS proxy bolted on as `devPlugin`. Also implements `/api/config` for dev. |
| `Dockerfile` | `node:20-slim`, `npm ci` → `npm run build` → `npm start`. Cloud Run target. |
| `PROGRESS.md` | Bilingual (EN/中文) running log of what shipped and why. Treat as historical context, not a spec. |
| `CHANGELOG.md` | Versioned changelog. Latest: 1.2.0 (audio context suspension fix). |

## Dev workflow

```bash
npm install                 # already done
# Fill in .env.local — GEMINI_API_KEY + VITE_GOOGLE_MAPS_API_KEY
npm run dev                 # http://localhost:3000
npm run typecheck           # tsc --noEmit
npm run test                # vitest (currently just src/utils.test.ts)
npm run build               # vite build → dist/
npm start                   # node index.js (serves dist/, requires prior build)
```

Both `gemini-ws.js` and `vite.config.ts` call `dotenv.config()` on `.env.local`, so a single file at repo root is enough — no need to duplicate.

## Required environment variables

| Var | Where it's used | Notes |
|---|---|---|
| `GEMINI_API_KEY` | `gemini-ws.js:102` — server-side only | Never exposed to the browser. |
| `VITE_GOOGLE_MAPS_API_KEY` | `vite.config.ts:24`, `index.js:20`, `src/lib/map_tools.ts:113` | Served to the browser via `GET /api/config` (runtime) *and* inlined at build time if `VITE_`-prefixed. Restrict the key to your domains in GCP Console. |
| `PORT` | `index.js:12` | Prod only. Defaults to 8080. |
| `DISABLE_HMR` | `vite.config.ts:44` | Set `true` to debug WS issues without HMR noise. |

## Gotchas & non-obvious behaviour

- **`navigate` / `teleport` are *client-side* tools**, not server-side. The proxy at `gemini-ws.js:148-158` intercepts these calls and forwards them to the browser as `client_tool_request`; `App.tsx:238-285` executes them against the Street View panorama and POSTs the result back as `client_tool_response`. If you add a new tool that runs in the browser, add its name to `CLIENT_SIDE_TOOLS` in `gemini-ws.js:11`.
- **Panorama is a global**: `App.tsx` and tool handlers read `(window as any)._vistaStreetWalkContext.panorama` set by `StreetWalkPanorama.tsx:65`. Bypasses React state intentionally — the Maps SDK manages the instance.
- **Audio pipeline**: 16 kHz PCM mic in, 24 kHz PCM out (`gemini-2.5-flash-native-audio-preview-09-2025` is fixed). The `pcm-processor` AudioWorklet is defined inline as a string in `App.tsx:40-67`.
- **AudioContext suspension fix** (1.2.0): after `getUserMedia`, the context may land in `suspended` state and the worklet silently no-ops. `App.tsx:370-374` resumes explicitly. Don't remove.
- **Mic ducking**: on Android the worklet keeps a parallel `source → pcmNode` direct connection (`App.tsx:500`) because the gain-only path doesn't reliably drive the worklet in Chromium. Ducking still works via `micGainNode → pcmNode`.
- **Session resumption**: Gemini Live issues a resumption handle; we cache it in `resumptionTokenRef` and reuse on reconnect. Fast-close (<15s) clears the token to force a clean connect — see `App.tsx:695-698`.
- **Reconnect**: exponential backoff up to 10 attempts (`src/utils.ts:22`). After 30s of stable connection the retry counter resets (`App.tsx:451-463`).
- **Static frames, not video**: the panorama is sampled via the Street View Static API at 480px every 2s (`CONFIG.VIDEO_FRAME_*`), not a live video stream. Cheaper, and the LLM only needs occasional snapshots.
- **WS origin allow-list**: `gemini-ws.js:60-83` permits localhost / LAN / `*.aihuddle.tech` / `*.run.app`. Add new prod domains there.
- **System instruction is inlined** in `gemini-ws.js:49-54`. There's no prompt template file — edit the string directly.

## Test coverage

Sparse: only `src/utils.test.ts` (helpers). No frontend or proxy tests. `npm run test` runs Vitest in one shot. The Gemini session + audio pipeline have no automated coverage — verify changes manually.

## Style / conventions observed

- TypeScript everywhere on the frontend, plain ESM JS on the server (`gemini-ws.js`, `index.js`).
- Tailwind v4 via `@tailwindcss/vite`. Utility classes in JSX.
- Component count is tiny on purpose — `App.tsx` is the orchestrator. Don't pre-emptively split it.
- Structured JSON logs from the proxy (`severity`, `event`, `sessionId`) — keep this shape for any new server logs (Cloud Logging consumes it).
- Bilingual notes (EN + 中文) appear in `PROGRESS.md`. The team writes in both; follow suit if you add entries there.

## Deployment

Cloud Run. Image built from the Dockerfile, run with `GEMINI_API_KEY` + `VITE_GOOGLE_MAPS_API_KEY` set as service env vars. URLs in the allow-list (`gemini-ws.js:60-67`): `vista.aihuddle.tech`, `demo.aihuddle.tech`, plus the autogenerated `*.run.app`.
