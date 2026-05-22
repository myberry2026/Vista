# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-05-22

### Added
- **Project Structure**: Set up Vite configuration (`vite.config.ts`), TypeScript configuration (`tsconfig.json`), Docker configuration (`Dockerfile`, `.dockerignore`), and production server (`index.js`).
- **Google Maps Integration**: Added `src/lib/map_tools.ts` for Street View control logic (navigation/teleportation) and `src/components/StreetWalkPanorama.tsx` as the container for Google Maps Street View panorama.
- **Gemini WebSocket Proxy**: Added `gemini-ws.js` supporting direct websocket connection to Gemini Live with inlined system instructions and client-side tool declarations (`navigate`, `teleport`).
- **Environment**: Added template and `.env.local` configuration for API keys (`GEMINI_API_KEY`, `VITE_GOOGLE_MAPS_API_KEY`).
- **Progress Tracking**: Initialized `PROGRESS.md` for bilingual tracking of tasks and learnings.
- **Frontend Core**: Created `src/App.tsx` implementing the unified virtual tour guide interface, dialogue transcripts, microphone audio stream handlers, PCM audio playback, and tool bindings. Added helper module `src/utils.ts` and tests `src/utils.test.ts`.
- **Exclusion Configuration**: Configured `package.json` test scripts and `tsconfig.json` compiler options to exclude the legacy `Aeva` codebase directory from verification pipelines.

## [1.1.0] - 2026-05-22

### Changed
- **Rebranding**: Renamed the application from Aeva to Vista with the tagline "Roam the world from your screen". Updated components (`src/App.tsx`, `src/components/StreetWalkPanorama.tsx`), configurations (`src/config.ts`), tests (`src/utils.test.ts`), and helper utilities (`src/utils.ts`).
- **Configuration Clean Up**: Removed legacy `Aeva/` directory exclusion rules from `tsconfig.json`, `package.json`, `.gitignore`, and `.dockerignore` since the folder is now completely out of the workspace.
- **Git History Clean Up**: Purged `proposal.md` and any traces of legacy `Aeva` commits from the Git history by re-initializing the local repository with a clean commit history.

