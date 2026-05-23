import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import 'dotenv/config';
import { defineConfig } from 'vite';
import { attachWebsocketServer } from './gemini-ws.js';
import { planTour } from './tour-planning.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readJsonBody(req: any): Promise<any> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const devPlugin = () => {
  return {
    name: 'dev-backend',
    configureServer(server: any) {
      if (server.httpServer) attachWebsocketServer(server.httpServer);
      server.middlewares.use((req: any, res: any, next: any) => {
        const requestPath = (req.url || '').split('?')[0];

        if (requestPath === '/api/config' && req.method === 'GET') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            VITE_GOOGLE_MAPS_API_KEY: process.env.VITE_GOOGLE_MAPS_API_KEY || ''
          }));
          return;
        }

        if (requestPath === '/api/plan-tour' && req.method === 'POST') {
          (async () => {
            try {
              const body = await readJsonBody(req);
              const area = typeof body?.area === 'string' ? body.area.trim() : '';
              if (!area) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'missing area' }));
                return;
              }
              const itinerary = await planTour(area);
              res.setHeader('Content-Type', 'application/json');
              if (itinerary.error) {
                res.statusCode = 502;
                res.end(JSON.stringify({ error: itinerary.error }));
                return;
              }
              res.statusCode = 200;
              res.end(JSON.stringify(itinerary));
            } catch (err: any) {
              console.error('[dev-backend] /api/plan-tour failed:', err);
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err?.message || String(err) }));
            }
          })();
          return;
        }

        next();
      });
    }
  };
};

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), devPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: {
        ignored: ['**/*.md']
      }
    }
  };
});
