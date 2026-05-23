import { WebSocketServer } from 'ws';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import fs from 'fs';

// Load env vars for local dev
if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local' });
}

const CLIENT_SIDE_TOOLS = ['navigate', 'teleport', 'tour_next', 'tour_back', 'tour_stop'];
const CLIENT_SIDE_SET = new Set(CLIENT_SIDE_TOOLS);

const toolsDeclaration = [
  {
    functionDeclarations: [
      {
        name: "navigate",
        description: "Move the user's Street View camera in a specific direction.",
        parameters: {
          type: "OBJECT",
          properties: {
            direction: {
              type: "STRING",
              description: "The direction to move or look. E.g., 'forward', 'backward', 'left', 'right', 'around'."
            }
          },
          required: ["direction"]
        }
      },
      {
        name: "teleport",
        description: "Teleport the user's Street View to a completely new, famous, or specific location by name.",
        parameters: {
          type: "OBJECT",
          properties: {
            location: {
              type: "STRING",
              description: "The name of the place to teleport to. E.g., 'Times Square, NY', 'Eiffel Tower', 'Shibuya Crossing'."
            }
          },
          required: ["location"]
        }
      },
      {
        name: "tour_next",
        description: "Advance the active guided tour to the next stop. Call this ONLY when the user gives an affirmative reply to continue (e.g. 'next', 'continue', \"let's go\", 'sure', 'OK', 'yep next one', '下一个', '继续', '走吧'). Do not call if the user asks a question or wants to linger.",
        parameters: { type: "OBJECT", properties: {} }
      },
      {
        name: "tour_back",
        description: "Go back to the previous stop on the active guided tour. Call this when the user asks to revisit the previous stop (e.g. 'back', 'previous', 'go back', '上一个', '回到上一站').",
        parameters: { type: "OBJECT", properties: {} }
      },
      {
        name: "tour_stop",
        description: "End the active guided tour. Call this ONLY when the user explicitly asks to stop or end the tour (e.g. 'stop the tour', 'end tour', \"I'm done\", '结束游览').",
        parameters: { type: "OBJECT", properties: {} }
      }
    ]
  }
];

const DEFAULT_SYSTEM_INSTRUCTION = `You are a virtual tour guide. You guide the user through famous places using Google Street View.
You should be engaging, informative, and friendly.
You have access to the 'navigate' and 'teleport' tools to move around.
Talk in a friendly tour-guide voice. Since you receive a live video stream of the user's Street View frame, you can see what is currently on the screen.
Describe the landmarks, buildings, and streets that you see, and respond dynamically to user requests.
Move the camera when they ask you to turn left, right, or go forward, or teleport them to new locations when they ask. Keep your responses relatively short, conversational, and tailored to what is visible.

# Guided Tour mode
The user may also start a multi-stop guided tour. When they do, you will receive system messages of the form:
"[Tour] Arrived at Stop K of N: <name>. Read this narration aloud verbatim, then ask if they'd like to continue or have a question: \"<narration>\""

In Guided Tour mode:
1. Read the provided narration aloud closely (you may smooth phrasing slightly but do not invent facts).
2. Then ASK the user whether they'd like to head to the next stop, or whether they have a question first.
3. If they affirm (any language), call the 'tour_next' tool.
4. If they ask to go back, call 'tour_back'. If they ask to stop the tour, call 'tour_stop'.
5. If they ask a question, answer it (using what you see in the live frame and what you know). Then re-offer to continue. Do NOT call tour_next without an affirmative reply.
6. The 'navigate' and 'teleport' tools are still available for ad-hoc detours during a tour.`;

export function attachWebsocketServer(server) {
  const wss = new WebSocketServer({ noServer: true });
  console.log('[GeminiWS] WebSocket Server attached to /api/live');

  const allowedOrigins = [
    'https://vista.aihuddle.tech',
    'https://demo.aihuddle.tech',
    'https://vista-prod-410817639831.us-central1.run.app',
    'https://staging.aihuddle.tech',
    'https://demo-staging.aihuddle.tech',
    'https://vista-410817639831.us-central1.run.app'
  ];

  server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;
    const pathname = request.url ? request.url.split('?')[0] : '';
    
    // Check if origin is allowed (localhost and LAN are allowed for local development)
    const isLocalDev = origin === undefined || (origin && (
      origin.startsWith('http://localhost:') || 
      origin.startsWith('http://127.0.0.1:') || 
      origin.match(/^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/)
    ));
    const isAllowedOrigin = origin && (
      allowedOrigins.includes(origin) || 
      origin.endsWith('.aihuddle.tech') || 
      origin.endsWith('.run.app')
    );

    if (pathname === '/api/live') {
      if (!isLocalDev && !isAllowedOrigin) {
        console.warn(`[GeminiWS] ❌ Unauthorized origin rejected: ${origin}`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', (ws) => {
    let ai;
    try {
      if (!process.env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is not set');
      }
      ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    } catch (e) {
      console.error('[GeminiWS] Failed to init AI', e);
      ws.close(1011, 'Missing API Key on Server');
      return;
    }

    let sessionPromise = null;
    let sessionMetadata = {
      sessionId: `sess_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      startTime: Date.now(),
      model: "gemini-2.5-flash-native-audio-preview-09-2025",
      tokens: { input: 0, output: 0 }
    };

    console.log(JSON.stringify({
      severity: "INFO",
      event: "tour_guide_session_started",
      ...sessionMetadata
    }));

    ws.on('message', async (messageStr) => {
      try {
        const data = JSON.parse(messageStr);

        if (data.type === 'connect') {
          const baseConfig = data.config || {};
          const instructionText = DEFAULT_SYSTEM_INSTRUCTION;
          const combinedInstruction = { parts: [{ text: instructionText }] };
          const appliedTools = [ ...toolsDeclaration, ... (baseConfig.tools || []) ];

          sessionPromise = ai.live.connect({
            model: "gemini-2.5-flash-native-audio-preview-09-2025",
            config: {
              ...baseConfig,
              systemInstruction: combinedInstruction,
              tools: appliedTools
            },
            callbacks: {
              onopen: () => {
                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'onopen' }));
              },
              onmessage: async (msg) => {
                if (msg.toolCall && msg.toolCall.functionCalls) {
                  const allCalls = msg.toolCall.functionCalls;
                  const clientCalls = [];
                  for (const call of allCalls) {
                    if (CLIENT_SIDE_SET.has(call.name)) {
                      clientCalls.push({ id: call.id, name: call.name, args: call.args || {} });
                    }
                  }
                  if (clientCalls.length > 0 && ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify({ type: 'client_tool_request', calls: clientCalls }));
                  }
                }
                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'onmessage', message: msg }));
              },
              onclose: (event) => {
                const closeInfo = {
                  code: event?.code,
                  reason: event?.reason,
                  message: event?.message,
                  type: event?.type,
                };
                console.warn(JSON.stringify({
                  severity: "WARNING",
                  event: "gemini_session_closed",
                  closeInfo,
                  sessionDurationSec: Math.round((Date.now() - sessionMetadata.startTime) / 1000),
                  ...sessionMetadata,
                }));
                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'onclose', event: closeInfo }));
              },
              onerror: (error) => {
                console.error(JSON.stringify({ severity: "ERROR", event: "gemini_api_error", error: error.message || error, ...sessionMetadata }));
                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'onerror', error: error.message || error }));
              }
            }
          });
          
          try { await sessionPromise; } catch (err) {
             if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'onerror', error: err.message || err }));
          }

        } else if (data.type === 'sendRealtimeInput') {
          const session = await sessionPromise;
          const inputParam = Array.isArray(data.inputs) ? data.inputs[0] : (data.input || data.inputs);
          if (session) session.sendRealtimeInput(inputParam);
        } else if (data.type === 'sendClientContent') {
          const session = await sessionPromise;
          if (session) {
            session.sendClientContent(data.content);
          }
        } else if (data.type === 'client_tool_response') {
          const session = await sessionPromise;
          if (session && data.responses && Array.isArray(data.responses)) {
            session.sendToolResponse({ functionResponses: data.responses });
          }
        } else if (data.type === 'close') {
          const session = await sessionPromise;
          if (session) session.close();
          sessionPromise = null;
        }
      } catch (e) {
        console.error('[GeminiWS] Error processing WS message', e);
      }
    });

    ws.on('close', async () => {
      const durationSeconds = (Date.now() - sessionMetadata.startTime) / 1000;
      console.log(JSON.stringify({ severity: "INFO", event: "tour_guide_session_ended", duration_seconds: durationSeconds, ...sessionMetadata }));
      if (sessionPromise) {
        try {
          const session = await sessionPromise;
          if (session && session.close) session.close();
        } catch(e) {}
        sessionPromise = null;
      }
    });
  });

  return wss;
}
