# Vista: Roam the world from your screen

[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run)

Vista is a standalone, minimal Web App that allows you to explore the world through Google Street View with an AI-powered virtual tour guide.

## Features
- **AI Tour Guide**: Powered by Gemini Live (Multimodal WebSocket).
- **Street View Integration**: Navigate and teleport across the globe.
- **Voice Interaction**: Talk to the guide in real-time.

## Quick Start (Local Development)

1. **Clone the repository**:
   ```bash
   git clone https://github.com/myberry2026/Vista.git
   cd Vista
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Set up environment variables**:
   Create a `.env.local` file:
   ```env
   GEMINI_API_KEY=your_gemini_api_key
   VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key
   ```

4. **Run the development server**:
   ```bash
   npm run dev
   ```

## Deployment

### Cloud Run (One-Click)
Click the button above to deploy directly to your Google Cloud Project. You will be prompted for your API keys.

### Manual Docker Deployment
```bash
docker build -t vista .
docker run -p 8080:8080 -e GEMINI_API_KEY=xxx -e VITE_GOOGLE_MAPS_API_KEY=xxx vista
```

## License
MIT
