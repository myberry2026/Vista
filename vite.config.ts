import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import 'dotenv/config';
import { defineConfig } from 'vite';
import { attachWebsocketServer } from './gemini-ws.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
