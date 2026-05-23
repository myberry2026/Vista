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
- **Exclusion Configuration**: Configured `package.json` test scripts and `tsconfig.json` compiler options to exclude legacy project codebase directory from verification pipelines.

## [1.1.0] - 2026-05-22

### Changed
- **Branding**: Finalized application branding as Vista with the tagline "Roam the world from your screen". Updated components (`src/App.tsx`, `src/components/StreetWalkPanorama.tsx`), configurations (`src/config.ts`), tests (`src/utils.test.ts`), and helper utilities (`src/utils.ts`).
- **Configuration Clean Up**: Removed legacy directory exclusion rules from `tsconfig.json`, `package.json`, `.gitignore`, and `.dockerignore` since the folder is now completely out of the workspace.
- **Git History Clean Up**: Purged `proposal.md` and any traces of legacy project commits from the Git history by re-initializing the local repository with a clean commit history.

## [1.2.0] - 2026-05-22

### Fixed
- **Audio Context Suspension**: Resolved microphone voice recognition failure by checking if `AudioContext` is suspended (often due to browser gesture requirements during async `getUserMedia` calls) and explicitly calling `resume()` to start the AudioWorklet node.
- **Audio Graph**: Compared and cleaned up the Audio Graph pipeline, avoiding duplicate direct connections found in reference implementations to preserve functioning mic ducking and mute capabilities.

## [1.3.0] - 2026-05-22

### Added
- **One-Click Deployment**: Added `app.json` and a "Run on Google Cloud" button in `README.md` to simplify deployment to Cloud Run.
- **Documentation**: Initialized `README.md` with features, setup guide, and deployment instructions.

## [1.4.0] - 2026-05-22

### Added
- **CI/CD Pipeline**: Initialized deployment workflow. Created `.github/workflows/deploy.yml` for automated testing and deployment to Google Cloud Run on push to `master`.
- **Secrets Management**: Integrated Google Cloud Secret Manager for handling `GEMINI_API_KEY` and `VITE_GOOGLE_MAPS_API_KEY` in the production environment.
