# Product Requirement Document (PRD): Vista Multi-Attraction Tour Planner

This document specifies the product requirements for the **Multi-Attraction Tour Planner** feature in the **Vista** virtual street view tour guide web application. All question branching and image recognition features are out of scope.

---

## 1. Executive Summary & Goals

### Context
Vista is a Web App that acts as an interactive, live voice tour guide using Google Street View and Gemini Live API over WebSockets. Currently, it operates in a single-point free-roam mode: the user is placed at one location and must manually direct the guide or teleport to single, disjointed spots.

### Goals
1. **Continuous Travel Experience**: Transition Vista from a single-point roam tool into a continuous **Multi-Attraction City Tour** platform. Users can experience a coherent tour of a city/region rather than jumping to isolated spots.
2. **Fact-Grounded Narration**: Generate structured itineraries using dual-grounding (Google Search + Google Maps) to ensure all tourist sites, paths, and explanations are real and historically/geographically accurate.
3. **Wow Aesthetics**: Present the user with a floating "Programs" overlay card utilizing glassmorphism and subtle micro-animations to track itinerary progress in real-time.

---

## 2. Target User Flows

```
[ User enters city e.g. "Tokyo" via input or voice ]
                         │
                         ▼
[ Backend plans 3-5 grounded stops & saves itinerary state ]
                         │
                         ▼
[ Left-side Floating Programs Overlay appears with timeline ]
                         │
                         ▼
[ Camera teleports to Stop 1. Pulse Beacon flashes on Stop 1 ]
                         │
                         ▼
[ Gemini Live reads Stop 1 Narration & invites user to look around ]
                         │
                         ▼
[ User clicks "Next" or clicks Spot 2 in the timeline card ]
                         │
                         ▼
- Teleports camera to Spot 2
- Highlights Spot 2 Card in timeline
- Gemini Live reads Spot 2 Narration
- Marks Spot 1 as Visited (Checked)
```

---

## 3. Detailed Functional Requirements

### Feature Group 1: Multi-Spot Route Generation (Planner)
When a user requests a tour of a city/area:
1. **Dual Grounding Constraint**: The planning engine must combine Google Search Grounding and Google Maps Grounding to discover 3-5 real, notable spots.
2. **Sensible Routing**: The generated spots must be arranged in a logical geographic sequence (avoiding chaotic back-and-forth jumping).
3. **Itinerary Contract**: The planner must return a JSON payload matching the following structure:
   * `tour_title`: E.g., "A Historical Walk in Stanford University".
   * `area`: The user-specified query.
   * `stops`: List of stops, each containing:
     * `order` (integer): 1-based order.
     * `name` (string): Specific name of the landmark.
     * `stop_type` (enum): `building` | `monument` | `viewpoint` | `natural_feature` | `district` | `other`.
     * `map_query` (string): Geocodable search string (e.g., "Hoover Tower, Stanford University").
     * `narration` (string): 2-3 sentences of conversational, fact-grounded text in English.
     * `look_for` (string): One specific visual cue (e.g., "the observation deck at the top of the tower").
     * `duration_sec` (integer): Recommended linger time in seconds.

### Feature Group 2: Programs Overlay (Itinerary Panel UI)
A floating itinerary timeline displayed directly over the Street View Panorama on the left side of the screen.
1. **Visual Style**:
   * Elegant glassmorphism: Semi-transparent dark background (`bg-zinc-950/75`), heavy backdrop blur (`backdrop-blur-md`), and a thin, subtle border (`border border-zinc-800/80`).
   * Vibrant emerald green theme (`emerald-500`) for active indicators.
2. **Timeline Indicators**:
   * **Visited Stops** (index < activeIndex): Display a solid green checked circle (e.g., `✓`) or ticked indicator.
   * **Active Stop** (index === activeIndex): Display an emerald circular badge containing the stop number, styled with a pulsing beacon glow animation (expanding wave of light) to catch the eye. The stop card itself should have a subtle border highlight.
   * **Upcoming Stops** (index > activeIndex): Displayed in a semi-transparent, locked style with grey circular numbers.
3. **Progress Bar**: A slim progress bar at the bottom showing percentage completion (e.g., 2/4 stops = 50%).
4. **Interactive Controls**:
   * `Prev` / `Next` button triggers to manually navigate backward and forward.
   * Clicking directly on any Spot card in the timeline must teleport the camera to that spot immediately.

### Feature Group 3: Gemini Live Narration Sync
1. **State Machine Integration**: Frontend implements a state machine (derived from `TourStateMachine`) to manage the current active stop index.
2. **WS Synchronisation Prompt**: On arrival at any stop (via auto-play, clicking Next, or direct card click), the frontend must:
   * Teleport the Street View camera to the stop's `map_query`.
   * Send a silent system prompt to Gemini Live over the active WebSocket connection:
     > `[System] You have arrived at Spot ${order}: ${name}. Please greet the user and read the following narration: "${narration}". Then invite them to look around or ask questions.`
   * Ensure that the video frame loop continues streaming the user's active viewport so the AI is visually grounded.

---

## 4. Edge Cases & Exception Handling

1. **Geocoding or Street View Missing at Stop**:
   * *Scenario*: A planned spot is real but Google Geocoding fails, or Street View does not exist within a 500m radius.
   * *Resolution*: Display a toast warning: "Street View not available at this attraction. Skipping..." The system automatically skips to the next spot, or allows the user to manually click another spot.
2. **API Key Fallback**:
   * *Scenario*: The build-time environment variable is missing on deploy.
   * *Resolution*: Provide the `/api/config` runtime endpoint so the frontend can dynamically fetch the API key from Google Cloud Secrets on startup.

---

## 5. Acceptance Criteria

* Entering a city name generates a valid 3-5 spot tour with real, grounded details.
* The left-side floating timeline renders properly with glassmorphism, highlights the active stop with a pulsing green beacon, and checks off visited stops.
* Clicking any spot card successfully teleports the camera to that spot, and Gemini Live reads the correct narration.
* The "Next" and "Prev" buttons navigate successfully through the tour, ending with a short closing summary.
