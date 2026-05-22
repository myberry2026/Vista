import express from 'express';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { attachWebsocketServer } from './gemini-ws.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.text());
app.use(express.json());

// Serving runtime config to frontend
app.get('/api/config', (req, res) => {
  res.status(200).json({
    VITE_GOOGLE_MAPS_API_KEY: process.env.VITE_GOOGLE_MAPS_API_KEY || ''
  });
});

const DIST_PATH = path.join(__dirname, 'dist');
if (fs.existsSync(DIST_PATH)) {
  app.use(express.static(DIST_PATH));
  
  // Fallback to index.html for SPA routing
  app.get('*', (req, res) => {
    res.sendFile(path.join(DIST_PATH, 'index.html'));
  });
} else {
  console.warn(`[Server] 'dist' directory not found. Serving API routes only. Dev server should be used.`);
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Production server is running at http://0.0.0.0:${PORT}`);
});

// Attach WebSocket Server
const wss = attachWebsocketServer(server);

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received. Closing server...');
  wss.close(() => {
    server.close(() => {
      console.log('[Server] Server closed. Exiting.');
      process.exit(0);
    });
  });
});
