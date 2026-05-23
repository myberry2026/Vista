/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect, useCallback, KeyboardEvent } from 'react';
import { 
  Play, 
  Square, 
  Mic, 
  MicOff, 
  Send, 
  Compass, 
  Settings, 
  Volume2, 
  VolumeX, 
  RefreshCw, 
  ChevronLeft, 
  ChevronRight, 
  ChevronUp, 
  ChevronDown, 
  RotateCcw,
  Sparkles,
  MapPin,
  Activity,
  AlertCircle
} from 'lucide-react';
import { StreetWalkPanorama } from './components/StreetWalkPanorama';
import { TourOverlay } from './components/TourOverlay';
import { CONFIG } from './config';
import { uint8ArrayToBase64, getReconnectDelayMs } from './utils';
import { handleNavigate, handleTeleport, resolveMapsApiKey } from './lib/map_tools';
import { useTour } from './lib/useTour';

export interface TranscriptItem {
  id: string;
  role: 'user' | 'model';
  text: string;
  isFinal: boolean;
}

const pcmProcessorCode = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = ${CONFIG.AUDIO_BUFFER_SIZE};
    this.buffer = new Int16Array(this.bufferSize);
    this.offset = 0;
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0];
      for (let i = 0; i < channelData.length; i++) {
        let s = Math.max(-1, Math.min(1, channelData[i]));
        this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        
        if (this.offset >= this.bufferSize) {
          const outBuffer = new Int16Array(this.buffer);
          this.port.postMessage(outBuffer.buffer, [outBuffer.buffer]);
          this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

function sanitizeTranscriptText(text: string) {
  const withoutNoise = text.replace(/<NOISE>/gi, '');
  return withoutNoise.trim().length === 0 ? '' : withoutNoise;
}

function isNonRetriableMediaPermissionError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err || '');
  const lowered = message.toLowerCase();
  return (
    lowered.includes('notallowederror') ||
    lowered.includes('permission denied') ||
    lowered.includes('request is not allowed by the user agent') ||
    lowered.includes('platform in the current context')
  );
}

export default function App() {
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'reconnecting'>('idle');
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioSource, setSelectedAudioSource] = useState<string>('default');
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);
  const [textInput, setTextInput] = useState('');
  const [isContinuousTalking, setIsContinuousTalking] = useState(CONFIG.DEFAULT_AUTO_CHAT_ENABLED);
  const [autoChatDelay, setAutoChatDelay] = useState<number>(1000);
  const [showSettings, setShowSettings] = useState(false);
  const tourController = useTour();
  const tourActive = tourController.tour !== null;
  const activeStopMapQuery = tourController.activeStop?.map_query ?? null;
  const activeStopName = tourController.activeStop?.name ?? null;
  const activeStopNarration = tourController.activeStop?.narration ?? null;
  const activeStopIndex = tourController.activeIndex;
  const totalStops = tourController.tour?.stops.length ?? 0;
  // Stash the controller in a ref so handleClientToolCall (which is a
  // useCallback with no deps) can reach the latest version when tour_next
  // / tour_back / tour_stop fire.
  const tourControllerRef = useRef(tourController);
  useEffect(() => { tourControllerRef.current = tourController; }, [tourController]);
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  // Refs for audio pipeline
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const micGainNodeRef = useRef<GainNode | null>(null);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextPlayTimeRef = useRef<number>(0);
  const subtitleTimeoutsRef = useRef<number[]>([]);
  
  // Refs for synchronization
  const isMicMutedRef = useRef(isMicMuted);
  const isContinuousTalkingRef = useRef(isContinuousTalking);
  const playbackSpeedRef = useRef(playbackSpeed);
  const autoChatDelayRef = useRef(autoChatDelay);
  const selectedAudioSourceRef = useRef(selectedAudioSource);

  // Connection session tracking
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const sessionRef = useRef<any>(null);
  const sessionGenRef = useRef(0);
  const retryCountRef = useRef(0);
  const resumptionTokenRef = useRef<string | null>(null);
  const userInitiatedStopRef = useRef(false);
  const nativeErrorFiredRef = useRef(false);

  // Timers and timing logs
  const sessionOpenedAtRef = useRef(0);
  const lastSilenceTimeRef = useRef(0);
  const videoIntervalRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Sync state values to refs
  useEffect(() => { isMicMutedRef.current = isMicMuted; }, [isMicMuted]);
  useEffect(() => { isContinuousTalkingRef.current = isContinuousTalking; }, [isContinuousTalking]);
  useEffect(() => { playbackSpeedRef.current = playbackSpeed; }, [playbackSpeed]);
  useEffect(() => { autoChatDelayRef.current = autoChatDelay; }, [autoChatDelay]);
  useEffect(() => { selectedAudioSourceRef.current = selectedAudioSource; }, [selectedAudioSource]);

  // Scroll to bottom on new transcripts
  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcript]);

  // Fly the Street View camera whenever the active tour stop changes.
  useEffect(() => {
    if (!activeStopMapQuery) return;
    let cancelled = false;
    const panorama = (window as any)._vistaStreetWalkContext?.panorama;
    if (!panorama) {
      console.warn('[TourGuide] Tour stop changed but panorama is not ready yet.');
      return;
    }
    if (typeof google === 'undefined' || !google.maps?.Geocoder) {
      console.warn('[TourGuide] Tour stop changed but Google Maps API not loaded.');
      return;
    }
    console.log(`[TourGuide] Tour → flying to "${activeStopMapQuery}"`);
    handleTeleport(
      activeStopMapQuery,
      panorama,
      new google.maps.Geocoder(),
      new google.maps.StreetViewService(),
    ).then(res => {
      if (cancelled) return;
      if (res.status === 'success') {
        setTranscript(prev => [...prev, {
          id: `tour-arrive-${Date.now()}`,
          role: 'model',
          text: `[Tour] Arrived at ${activeStopName}`,
          isFinal: true,
        }]);

        // If Live is connected, hand the narration to the guide so it speaks it
        // aloud and then waits for the user's reply ("next" / a question / etc.).
        if (statusRef.current === 'connected' && sessionRef.current && activeStopNarration) {
          const stopNum = activeStopIndex + 1;
          const escaped = activeStopNarration.replace(/"/g, '\\"');
          try {
            sessionRef.current.sendClientContent({
              turns: [{
                role: 'user',
                parts: [{
                  text:
                    `[Tour] Arrived at Stop ${stopNum} of ${totalStops}: ${activeStopName}. ` +
                    `Read this narration aloud verbatim, then ask if they'd like to continue ` +
                    `or have a question: "${escaped}"`,
                }],
              }],
              turnComplete: true,
            });
          } catch (e) {
            console.error('[TourGuide] Failed to inject tour narration:', e);
          }
        }
      } else {
        setTranscript(prev => [...prev, {
          id: `tour-skip-${Date.now()}`,
          role: 'model',
          text: `[Tour] Street View not available for ${activeStopName} — ${res.message || 'skipping'}`,
          isFinal: true,
        }]);
      }
    });
    return () => { cancelled = true; };
  }, [activeStopMapQuery, activeStopName, activeStopNarration, activeStopIndex, totalStops]);

  // Load and refresh input devices
  useEffect(() => {
    let mounted = true;
    const mediaDevices = navigator.mediaDevices;
    const refreshDevices = async () => {
      if (!mediaDevices || !mounted) return;
      try {
        const devices = await mediaDevices.enumerateDevices();
        const aInputDevices = devices.filter(d => 
          d.kind === 'audioinput' && 
          !d.label.toLowerCase().includes('speakerphone')
        );
        const uniqueMics = Array.from(new Map(aInputDevices.map((d, i) => [`${d.deviceId || 'unknown'}-${d.label || 'dev'+i}`, d])).values());
        if (mounted) {
          setAudioDevices(uniqueMics);
          console.log('[TourGuide] Mics discovered:', uniqueMics.map(m => m.label));
        }
      } catch (err) {
        console.error('[TourGuide] Failed to enumerate devices:', err);
      }
    };

    void refreshDevices();
    const handleDeviceChange = () => { void refreshDevices(); };
    mediaDevices?.addEventListener('devicechange', handleDeviceChange);
    return () => {
      mounted = false;
      mediaDevices?.removeEventListener('devicechange', handleDeviceChange);
    };
  }, []);

  // Duck mic gain when bot is speaking to prevent echoes
  const syncMicMute = useCallback(() => {
    if (!micGainNodeRef.current) return;
    const isBotSpeaking = activeSourcesRef.current.size > 0;
    const isAndroid = /Android/i.test(navigator.userAgent);
    
    // Dip gain to 0.05 on Android where cancellation is poor, or keep at 1.0 on Desktop
    const targetGain = isBotSpeaking ? (isAndroid ? 0.05 : 1.0) : 1.0;
    const now = audioContextRef.current?.currentTime || 0;
    micGainNodeRef.current.gain.setTargetAtTime(targetGain, now, 0.03);
    setIsAiSpeaking(isBotSpeaking);
    console.log(`[TourGuide] syncMicMute: botSpeaking=${isBotSpeaking}, micGain=${targetGain}`);
  }, []);

  // Teardown connection session resources
  const cleanupSession = useCallback(() => {
    console.log('[TourGuide] Cleaning up active session resources...');
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }

    if (videoIntervalRef.current) {
      clearInterval(videoIntervalRef.current);
      videoIntervalRef.current = null;
    }

    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach(track => track.stop());
      audioStreamRef.current = null;
    }

    activeSourcesRef.current.forEach(src => {
      try { src.stop(); } catch (e) {}
    });
    activeSourcesRef.current.clear();

    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch (e) {}
      audioContextRef.current = null;
    }

    subtitleTimeoutsRef.current.forEach(timerId => clearTimeout(timerId));
    subtitleTimeoutsRef.current = [];
    setIsAiSpeaking(false);
  }, []);

  // User-initiated session stop
  const stopSession = useCallback(() => {
    console.log('[TourGuide] Session stopping (user action)...');
    userInitiatedStopRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    retryCountRef.current = 0;
    setReconnectAttempt(0);
    resumptionTokenRef.current = null;
    cleanupSession();
    setStatus('idle');
  }, [cleanupSession]);

  // Main client tool dispatcher
  const handleClientToolCall = useCallback(async (ws: WebSocket, calls: any[]) => {
    const responses: any[] = [];
    for (const call of calls) {
      console.log(`[TourGuide] Execute client-side tool: ${call.name}`, call.args);
      let result: Record<string, any> = {};
      try {
        if (call.name === 'navigate') {
          const panorama = (window as any)._vistaStreetWalkContext?.panorama;
          if (!panorama) throw new Error('Street View panorama is not loaded in UI yet.');
          result = handleNavigate(call.args.direction, panorama);
        } else if (call.name === 'teleport') {
          const panorama = (window as any)._vistaStreetWalkContext?.panorama;
          if (!panorama) throw new Error('Street View panorama is not loaded in UI yet.');
          if (typeof google === 'undefined' || !google.maps?.Geocoder) {
            throw new Error('Google Maps API is not loaded.');
          }
          result = await handleTeleport(
            call.args.location,
            panorama,
            new google.maps.Geocoder(),
            new google.maps.StreetViewService()
          );
        } else if (call.name === 'tour_next') {
          const ctl = tourControllerRef.current;
          if (!ctl.tour) {
            result = { status: 'error', message: 'No active guided tour.' };
          } else if (ctl.isEnded) {
            result = { status: 'error', message: 'Tour is already complete.' };
          } else {
            ctl.next();
            result = { status: 'success', action: 'Advanced to next stop' };
          }
        } else if (call.name === 'tour_back') {
          const ctl = tourControllerRef.current;
          if (!ctl.tour) {
            result = { status: 'error', message: 'No active guided tour.' };
          } else if (ctl.activeIndex <= 0) {
            result = { status: 'error', message: 'Already at the first stop.' };
          } else {
            ctl.prev();
            result = { status: 'success', action: 'Returned to previous stop' };
          }
        } else if (call.name === 'tour_stop') {
          const ctl = tourControllerRef.current;
          if (!ctl.tour) {
            result = { status: 'error', message: 'No active guided tour.' };
          } else {
            ctl.reset();
            result = { status: 'success', action: 'Tour ended' };
          }
        } else {
          result = { status: 'error', message: `Unknown tool: ${call.name}` };
        }
      } catch (err: any) {
        console.error(`[TourGuide] Tool execution error for ${call.name}:`, err);
        result = { status: 'error', message: err.message || String(err) };
      }
      
      responses.push({ id: call.id, name: call.name, response: result });
      
      // Visual notification in transcript for navigation actions
      if (result.status === 'success') {
        const details = call.name === 'teleport' ? `to ${call.args.location}` : `${call.args.direction}`;
        setTranscript(prev => [...prev, {
          id: `${Date.now()}-tool-${call.id}`,
          role: 'model',
          text: `[System Action] Guided camera ${details}`,
          isFinal: true
        }]);
      }
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'client_tool_response', responses }));
    }
  }, []);

  // Backoff reconnect scheduler
  const scheduleReconnect = useCallback(() => {
    if (userInitiatedStopRef.current) return;

    const attempt = retryCountRef.current;
    if (attempt >= CONFIG.RECONNECT_MAX_RETRIES) {
      console.error(`[TourGuide] Max reconnect attempts (${CONFIG.RECONNECT_MAX_RETRIES}) reached. Halting.`);
      retryCountRef.current = 0;
      setReconnectAttempt(0);
      resumptionTokenRef.current = null;
      setStatus('idle');
      return;
    }

    const delay = getReconnectDelayMs(attempt);
    const nextAttempt = attempt + 1;
    retryCountRef.current = nextAttempt;
    setReconnectAttempt(nextAttempt);
    setStatus('reconnecting');
    setTranscript(prev => [
      ...prev,
      {
        id: `${Date.now()}-reconnect-${nextAttempt}`,
        role: 'model',
        text: `[System] Reconnecting... attempt ${nextAttempt}/${CONFIG.RECONNECT_MAX_RETRIES}`,
        isFinal: true,
      },
    ]);

    console.log(`[TourGuide] Reconnecting in ${delay}ms...`);
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = window.setTimeout(() => {
      void connectToGemini();
    }, delay);
  }, []);

  // Establish connection to backend and start streaming
  const connectToGemini = async () => {
    const thisGen = ++sessionGenRef.current;
    nativeErrorFiredRef.current = false;
    
    try {
      const isReconnect = retryCountRef.current > 0;
      console.log(`[TourGuide] Connection start (reconnect=${isReconnect}, gen=${thisGen})`);
      
      if (!isReconnect) {
        setStatus('connecting');
        setTranscript([]);
      }

      // 1. Microphone capture
      const isAndroid = /Android/i.test(navigator.userAgent);
      const isSpecificDevice = selectedAudioSourceRef.current && selectedAudioSourceRef.current !== 'default';
      const shouldDisableEcho = isAndroid && isSpecificDevice;

      const audioConstraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: !shouldDisableEcho,
          noiseSuppression: true,
          autoGainControl: true,
        }
      };
      if (isSpecificDevice) {
        (audioConstraints.audio as MediaTrackConstraints).deviceId = { exact: selectedAudioSourceRef.current };
      }

      let audioStream: MediaStream;
      try {
        audioStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
      } catch (err) {
        console.warn('[TourGuide] Preferred mic failed, falling back to default:', err);
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      audioStreamRef.current = audioStream;

      // 2. Audio Context & Worklet setup
      if (audioContextRef.current) {
        try { audioContextRef.current.close(); } catch (e) {}
      }
      const audioCtx = new AudioContext({ sampleRate: CONFIG.AUDIO_SAMPLE_RATE });
      audioContextRef.current = audioCtx;
      nextPlayTimeRef.current = audioCtx.currentTime;

      if (audioCtx.state === 'suspended') {
        console.warn('[TourGuide] AudioContext is suspended (due to async getUserMedia call stack shift). Resuming...');
        await audioCtx.resume();
        console.log(`[TourGuide] AudioContext state after resume: ${audioCtx.state}`);
      }

      const blob = new Blob([pcmProcessorCode], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(workletUrl);

      const source = audioCtx.createMediaStreamSource(audioStream);
      const micGainNode = audioCtx.createGain();
      micGainNode.gain.value = 1.0;
      micGainNodeRef.current = micGainNode;
      const pcmNode = new AudioWorkletNode(audioCtx, 'pcm-processor');

      source.connect(micGainNode);
      micGainNode.connect(pcmNode);

      // 3. Connect WebSocket Proxy
      const resumptionHandle = resumptionTokenRef.current;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/live`;
      const ws = new WebSocket(wsUrl);

      const sessionPromise = new Promise<any>((resolve, reject) => {
        let sessionResolved = false;

        ws.onopen = () => {
          const connectConfig: Record<string, any> = {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            contextWindowCompression: {
              triggerTokens: CONFIG.CONTEXT_WINDOW_TRIGGER_TOKENS,
              slidingWindow: { targetTokens: CONFIG.CONTEXT_WINDOW_TARGET_TOKENS },
            },
          };
          if (resumptionHandle) {
            connectConfig.sessionResumption = { handle: resumptionHandle };
          }
          console.log('[TourGuide] Sending connect configs...');
          ws.send(JSON.stringify({ type: 'connect', userId: 'tour_guide_dev', config: connectConfig }));
        };

        ws.onmessage = async (event) => {
          try {
            const wsData = JSON.parse(event.data);
            if (!wsData) return;

            if (wsData.type === 'onopen') {
              const sessionAdapter = {
                sendRealtimeInput: (input: any) => {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'sendRealtimeInput', input }));
                  }
                },
                sendClientContent: (content: any) => {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'sendClientContent', content }));
                  }
                },
                close: () => {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'close' }));
                  }
                  ws.close();
                },
              };
              sessionResolved = true;
              resolve(sessionAdapter);

              sessionOpenedAtRef.current = Date.now();
              lastSilenceTimeRef.current = Date.now();
              setStatus('connected');
              console.log('✅ Live Tour Guide session connected successfully.');

              // Stable connection timer
              const stableCheckRetry = retryCountRef.current;
              if (stableCheckRetry > 0) {
                setTimeout(() => {
                  if (sessionGenRef.current === thisGen && retryCountRef.current === stableCheckRetry) {
                    console.log('[TourGuide] Session stable for 30s, resetting retry count');
                    retryCountRef.current = 0;
                    setReconnectAttempt(0);
                  }
                }, 30000);
              } else {
                retryCountRef.current = 0;
                setReconnectAttempt(0);
              }

              // Welcome helper prompt
              let hasSentInitialPrompt = false;
              const sendInitialPrompt = () => {
                if (hasSentInitialPrompt || ws.readyState !== WebSocket.OPEN) return;
                hasSentInitialPrompt = true;
                ws.send(JSON.stringify({
                  type: 'sendClientContent',
                  content: {
                    turns: [{
                      role: 'user',
                      parts: [
                        { text: '[System] Connection established. Please greet the user enthusiastically as their virtual tour guide in English!' }
                      ]
                    }],
                    turnComplete: true,
                  }
                }));
              };
              setTimeout(sendInitialPrompt, 1500);

              // 4. Pipe mic PCM audio
              pcmNode.port.onmessage = (e) => {
                if (isMicMutedRef.current) return;
                const buffer = new Uint8Array(e.data);
                const base64Data = uint8ArrayToBase64(buffer);
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: 'sendRealtimeInput',
                    input: { media: { data: base64Data, mimeType: `audio/pcm;rate=${CONFIG.AUDIO_SAMPLE_RATE}` } },
                  }));
                }
              };
              // Direct source→worklet connection: the gain-only path doesn't reliably drive
              // AudioWorklet processing in Chromium. The mic ducking still works because
              // micGainNode→pcmNode remains connected in parallel.
              source.connect(pcmNode);

              // 5. Send Street View frame loop
              let isCapturing = false;
              const captureAndSendFrame = async () => {
                if (isCapturing) return;
                isCapturing = true;
                try {
                  const panorama = (window as any)._vistaStreetWalkContext?.panorama;
                  if (!panorama) return;

                  if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > 1024 * 1024) {
                    console.warn('[TourGuide] WS buffer heavy, dropping static frame.');
                    return;
                  }

                  const pos = panorama.getPosition();
                  const pov = panorama.getPov();
                  if (!pos || !pov) return;

                  const apiKey = await resolveMapsApiKey();
                  if (!apiKey) return;

                  const dim = CONFIG.VIDEO_FRAME_MAX_DIMENSION;
                  const staticUrl = `https://maps.googleapis.com/maps/api/streetview?size=${dim}x${dim}&location=${pos.lat()},${pos.lng()}&heading=${pov.heading}&pitch=${pov.pitch}&key=${apiKey}`;

                  const response = await fetch(staticUrl);
                  if (!response.ok) throw new Error(`Static API status: ${response.status}`);
                  const blob = await response.blob();
                  
                  const reader = new FileReader();
                  reader.onloadend = () => {
                    const dataUrl = reader.result as string;
                    const base64Data = dataUrl.split(',')[1];
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({
                        type: 'sendRealtimeInput',
                        input: { media: { data: base64Data, mimeType: 'image/jpeg' } },
                      }));
                      sendInitialPrompt();
                    }
                  };
                  reader.readAsDataURL(blob);
                } catch (err) {
                  console.error('[TourGuide] Failed to capture and stream Street View:', err);
                } finally {
                  isCapturing = false;
                }
              };

              // First capture immediately, then repeat
              captureAndSendFrame();
              videoIntervalRef.current = window.setInterval(captureAndSendFrame, CONFIG.VIDEO_FRAME_INTERVAL_MS);
            }

            if (wsData.type === 'client_tool_request') {
              handleClientToolCall(ws, wsData.calls);
            }

            if (wsData.type === 'onmessage') {
              const message = wsData.message;

              // Handle GoAway warnings
              if (message.goAway) {
                console.warn('[TourGuide] GoAway received from Gemini API. Scheduling reconnect...');
                cleanupSession();
                scheduleReconnect();
                return;
              }

              // Handle session resumption updates
              if (message.sessionResumptionUpdate) {
                const update = message.sessionResumptionUpdate;
                if (update.newHandle) resumptionTokenRef.current = update.newHandle;
              }

              // Interrupted playout handling
              if (message.serverContent?.interrupted) {
                subtitleTimeoutsRef.current.forEach(id => clearTimeout(id));
                subtitleTimeoutsRef.current = [];

                activeSourcesRef.current.forEach(src => {
                  try { src.stop(); } catch (e) {}
                });
                activeSourcesRef.current.clear();
                
                lastSilenceTimeRef.current = Date.now() + 1000;
                if (audioContextRef.current) {
                  nextPlayTimeRef.current = audioContextRef.current.currentTime;
                }
                setTranscript(prev => prev.map(item => !item.isFinal ? { ...item, isFinal: true } : item));
              }

              if (message.serverContent?.turnComplete) {
                lastSilenceTimeRef.current = Date.now() + 1000;
                setTranscript(prev => prev.map(item => !item.isFinal ? { ...item, isFinal: true } : item));
              }

              if (message.serverContent?.modelTurn || message.serverContent?.outputTranscription) {
                setTranscript(prev => prev.map(item => item.role === 'user' && !item.isFinal ? { ...item, isFinal: true } : item));
              }

              // Input speech transcription
              if (message.serverContent?.inputTranscription) {
                const t = message.serverContent.inputTranscription;
                setTranscript(prev => {
                  const cleanText = sanitizeTranscriptText(t.text || '');
                  const lastUser = prev.findLast(item => item.role === 'user');
                  if (!lastUser || lastUser.isFinal) {
                    if (!cleanText && !t.finished) return prev;
                    return [...prev, { id: Date.now().toString(), role: 'user', text: cleanText, isFinal: !!t.finished }];
                  } else {
                    return prev.map(item => 
                      item.id === lastUser.id 
                        ? { ...item, text: item.text + cleanText, isFinal: !!t.finished } 
                        : item
                    );
                  }
                });
              }

              // Play output PCM 24kHz audio
              const transcription = message.serverContent?.outputTranscription;
              const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
              const targetStartTime = audioCtx ? Math.max(audioCtx.currentTime, nextPlayTimeRef.current) : 0;

              if (base64Audio && audioCtx) {
                const binaryString = atob(base64Audio);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                  bytes[i] = binaryString.charCodeAt(i);
                }
                const pcm16 = new Int16Array(bytes.buffer);
                const audioBuffer = audioCtx.createBuffer(1, pcm16.length, 24000);
                const channelData = audioBuffer.getChannelData(0);
                const boost = CONFIG.REC_AI_BOOST;
                
                for (let i = 0; i < pcm16.length; i++) {
                  const sample = (pcm16[i] / 0x8000) * boost;
                  channelData[i] = Math.max(-1, Math.min(1, sample));
                }

                const src = audioCtx.createBufferSource();
                src.buffer = audioBuffer;
                src.connect(audioCtx.destination);
                
                src.onended = () => {
                  activeSourcesRef.current.delete(src);
                  syncMicMute();
                  if (activeSourcesRef.current.size === 0) {
                    lastSilenceTimeRef.current = Date.now() + 1000;
                  }
                };
                activeSourcesRef.current.add(src);

                src.playbackRate.value = playbackSpeedRef.current;
                src.start(targetStartTime);
                nextPlayTimeRef.current = targetStartTime + (audioBuffer.duration / playbackSpeedRef.current);
                lastSilenceTimeRef.current = Date.now() + ((nextPlayTimeRef.current - audioCtx.currentTime) * 1000) + 1000;
                syncMicMute();
              }

              // Output text transcription (subtitles) aligned with audio playback
              if (transcription) {
                const delayMs = audioCtx ? Math.max(0, (targetStartTime - audioCtx.currentTime) * 1000) : 0;
                const timerId = window.setTimeout(() => {
                  subtitleTimeoutsRef.current = subtitleTimeoutsRef.current.filter(id => id !== timerId);
                  const cleanText = sanitizeTranscriptText(transcription.text || '');
                  const isFinal = !!transcription.finished;

                  setTranscript(prev => {
                    const lastModel = prev.findLast(item => item.role === 'model');
                    if (!lastModel || lastModel.isFinal) {
                      if (!cleanText && !isFinal) return prev;
                      return [...prev, { id: Date.now().toString(), role: 'model', text: cleanText, isFinal }];
                    } else {
                      return prev.map(item => 
                        item.id === lastModel.id 
                          ? { ...item, text: item.text + cleanText, isFinal } 
                          : item
                      );
                    }
                  });
                }, delayMs);
                subtitleTimeoutsRef.current.push(timerId);
              }
            }

            if (wsData.type === 'onclose') {
              if (thisGen !== sessionGenRef.current) return;
              const code = wsData?.event?.code ?? 'unknown';
              const reason = wsData?.event?.reason ?? wsData?.event?.message ?? 'no reason';
              const lifetime = sessionOpenedAtRef.current > 0 ? Math.round((Date.now() - sessionOpenedAtRef.current) / 1000) : -1;
              console.warn(`[TourGuide] Socket closed. Code=${code}, Reason=${reason}, Lifetime=${lifetime}s`);

              if (sessionResolved && lifetime >= 0 && lifetime < 15 && resumptionTokenRef.current) {
                console.warn('[TourGuide] Fast close detected. Clearing resumption token to force clean connect.');
                resumptionTokenRef.current = null;
              }

              setTranscript(prev => [...prev, {
                id: `${Date.now()}-ws-onclose`,
                role: 'model',
                text: `[System] Session ended (code ${code}): ${reason}`,
                isFinal: true
              }]);
              
              cleanupSession();
              if (sessionResolved) {
                if (!userInitiatedStopRef.current) scheduleReconnect();
              } else {
                reject(new Error(`WebSocket closed early (${code}): ${reason}`));
              }
            }

            if (wsData.type === 'onerror') {
              if (thisGen !== sessionGenRef.current) return;
              console.error('[TourGuide] WS Error:', wsData.error);
              setTranscript(prev => [...prev, {
                id: `${Date.now()}-ws-onerror`,
                role: 'model',
                text: `[System] Connection error: ${wsData.error || 'Unknown server error'}`,
                isFinal: true
              }]);
              cleanupSession();
              if (sessionResolved) {
                if (!userInitiatedStopRef.current) scheduleReconnect();
              } else {
                reject(new Error(wsData.error || 'WS proxy error'));
              }
            }
          } catch (e) {
            console.error('[TourGuide] Error parsing ws frame:', e);
          }
        };

        ws.onclose = () => {
          if (thisGen !== sessionGenRef.current) return;
          if (nativeErrorFiredRef.current) return;
          cleanupSession();
          reject(new Error('WebSocket closed unexpectedly.'));
        };

        ws.onerror = (err) => {
          if (thisGen !== sessionGenRef.current) return;
          nativeErrorFiredRef.current = true;
          cleanupSession();
          reject(new Error('Failed to reach WebSocket server.'));
        };
      });

      sessionRef.current = await sessionPromise;
      console.log('[TourGuide] Session reference resolved.');

    } catch (err) {
      if (thisGen !== sessionGenRef.current) return;
      console.error('[TourGuide] Failed to connect:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setTranscript(prev => [...prev, {
        id: `${Date.now()}-connect-catch`,
        role: 'model',
        text: `[System] Connection failed: ${msg}`,
        isFinal: true
      }]);

      cleanupSession();
      if (isNonRetriableMediaPermissionError(err)) {
        userInitiatedStopRef.current = true;
        retryCountRef.current = 0;
        setReconnectAttempt(0);
        setStatus('idle');
        setTranscript(prev => [...prev, {
          id: `${Date.now()}-perm-denied`,
          role: 'model',
          text: '[System] Microphone permission denied. Please grant permission in browser settings and retry.',
          isFinal: true
        }]);
        return;
      }

      if (!userInitiatedStopRef.current) {
        scheduleReconnect();
      } else {
        setStatus('idle');
      }
    }
  };

  const startSession = async () => {
    console.log('[TourGuide] Starting new virtual street view tour guide session...');
    userInitiatedStopRef.current = false;
    retryCountRef.current = 0;
    setReconnectAttempt(0);
    resumptionTokenRef.current = null;
    await connectToGemini();
  };

  // Auto-chat active check interval
  useEffect(() => {
    const checkSilence = setInterval(() => {
      if (status !== 'connected' || !sessionRef.current) return;

      const isAudioQueueEmpty = audioContextRef.current 
        ? audioContextRef.current.currentTime >= nextPlayTimeRef.current 
        : true;

      // When guide is quiet and output queue is fully cleared
      if (activeSourcesRef.current.size === 0 && isAudioQueueEmpty) {
        const silenceDuration = Date.now() - lastSilenceTimeRef.current;
        if (!isContinuousTalkingRef.current) {
          // Auto-disconnect on idle when auto-chat is off
          if (silenceDuration > CONFIG.AUTO_DISCONNECT_SILENCE_MS) {
            setTranscript(prev => [...prev, {
              id: Date.now().toString(),
              role: 'model',
              text: '[System] Session auto-disconnected due to inactivity.',
              isFinal: true
            }]);
            stopSession();
          }
        } else if (silenceDuration > autoChatDelayRef.current) {
          // Trigger proactive guided narration
          console.log(`[TourGuide] ${autoChatDelayRef.current / 1000}s silence detected. Prompting guide...`);
          lastSilenceTimeRef.current = Date.now() + 5000; // grace period
          
          try {
            sessionRef.current.sendClientContent({
              turns: [{
                role: 'user',
                parts: [{ text: '[System] The user has been quiet for a moment. Please proactively tell them something interesting about the landmarks or area visible in the Street View camera stream!' }]
              }],
              turnComplete: true
            });
          } catch (e) {
            console.error('Failed to send proactive prompt:', e);
          }
        }
      }
    }, CONFIG.SILENCE_CHECK_INTERVAL_MS);

    return () => clearInterval(checkSilence);
  }, [status, stopSession]);

  // Send textual chat message
  const sendTextMessage = () => {
    if (!textInput.trim() || status !== 'connected' || !sessionRef.current) return;
    const msg = textInput.trim();
    setTranscript(prev => [...prev, { id: Date.now().toString(), role: 'user', text: msg, isFinal: true }]);
    setTextInput('');

    try {
      sessionRef.current.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: msg }] }],
        turnComplete: true
      });
      console.log('[TourGuide] Text message sent to guide:', msg);
    } catch (e) {
      console.error('Failed to send text message:', e);
    }
  };

  // Perform quick navigation
  const triggerManualNavigate = (direction: string) => {
    const panorama = (window as any)._vistaStreetWalkContext?.panorama;
    if (!panorama) return;
    console.log(`[TourGuide] Clicked manual move: ${direction}`);
    const res = handleNavigate(direction, panorama);
    
    // Log the manual action in chat
    setTranscript(prev => [...prev, {
      id: `manual-nav-${Date.now()}`,
      role: 'user',
      text: `[Navigate] ${direction}`,
      isFinal: true
    }]);

    if (res.status === 'success') {
      // Trigger a visual confirmation from guide
      setTimeout(() => {
        if (status === 'connected' && sessionRef.current) {
          try {
            sessionRef.current.sendClientContent({
              turns: [{
                role: 'user',
                parts: [{ text: `[System] User manually moved the Street View camera ${direction}. Please describe the new view!` }]
              }],
              turnComplete: true
            });
          } catch(e) {}
        }
      }, 500);
    }
  };

  // Teleport helper shortcuts
  const teleportShortcut = (locationName: string) => {
    const panorama = (window as any)._vistaStreetWalkContext?.panorama;
    if (!panorama) return;
    
    setTranscript(prev => [...prev, {
      id: `manual-tp-${Date.now()}`,
      role: 'user',
      text: `[Teleport] ${locationName}`,
      isFinal: true
    }]);

    if (typeof google !== 'undefined' && google.maps?.Geocoder) {
      setStatus('connecting'); // show transition loading state
      handleTeleport(
        locationName,
        panorama,
        new google.maps.Geocoder(),
        new google.maps.StreetViewService()
      ).then(res => {
        setStatus('connected');
        if (res.status === 'success') {
          setTimeout(() => {
            if (status === 'connected' && sessionRef.current) {
              try {
                sessionRef.current.sendClientContent({
                  turns: [{
                    role: 'user',
                    parts: [{ text: `[System] Teleported successfully to ${locationName}. Welcome the user and describe this location!` }]
                  }],
                  turnComplete: true
                });
              } catch(e) {}
            }
          }, 800);
        } else {
          setTranscript(prev => [...prev, {
            id: `tp-err-${Date.now()}`,
            role: 'model',
            text: `[System Error] Failed to teleport: ${res.message}`,
            isFinal: true
          }]);
        }
      });
    }
  };

  return (
    <div className="min-h-screen w-full bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-emerald-500/30">
      
      {/* Top Navbar */}
      <header className="h-16 px-6 border-b border-zinc-800 bg-zinc-900/60 backdrop-blur-md flex items-center justify-between z-30 sticky top-0">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-500/20">
            <Compass className="h-5 w-5 text-zinc-950 animate-spin-slow" />
          </div>
          <div>
            <h1 className="text-lg font-bold bg-gradient-to-r from-emerald-400 via-teal-300 to-cyan-400 bg-clip-text text-transparent tracking-tight">
              Vista
            </h1>
            <p className="text-xs text-zinc-400 font-medium">Roam the world from your screen</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Status Indicator */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-950/80 border border-zinc-800/80">
            <span className={`h-2.5 w-2.5 rounded-full ${
              status === 'connected' ? 'bg-emerald-500 animate-pulse' :
              status === 'reconnecting' ? 'bg-orange-500 animate-bounce' :
              status === 'connecting' ? 'bg-amber-500 animate-pulse' :
              'bg-zinc-500'
            }`} />
            <span className="text-xs font-mono font-medium text-zinc-300 uppercase tracking-wider">
              {status === 'connected' ? 'Active Guide' :
               status === 'reconnecting' ? `Reconnecting (${reconnectAttempt})` :
               status === 'connecting' ? 'Connecting...' :
               'Offline'}
            </span>
          </div>

          <button 
            onClick={() => setShowSettings(!showSettings)}
            className={`p-2 rounded-xl border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800 text-zinc-300 transition-all ${
              showSettings ? 'border-emerald-500/50 bg-emerald-500/5 text-emerald-400' : ''
            }`}
            title="Settings"
          >
            <Settings className="h-4.5 w-4.5" />
          </button>
        </div>
      </header>

      {/* Main Content Layout */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 p-6 h-[calc(100vh-64px)] overflow-hidden">
        
        {/* Left Section: Street View Panorama */}
        <section className="lg:col-span-8 bg-zinc-900/40 rounded-2xl border border-zinc-800/80 overflow-hidden flex flex-col relative shadow-2xl group">
          <div className="flex-1 w-full relative">
            <StreetWalkPanorama />

            {/* Guided tour overlay (planner → state machine → cards) */}
            <TourOverlay controller={tourController} />

            {/* Quick Suggestions — only shown when no tour is active */}
            {!tourActive && (
              <div className="absolute top-4 left-[352px] right-4 flex gap-2 flex-wrap pointer-events-auto z-10">
                <button onClick={() => teleportShortcut('Times Square, NY')} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-950/80 border border-zinc-800 hover:border-emerald-500/50 hover:bg-zinc-900 text-zinc-300 backdrop-blur-md transition-all">
                  🗽 Times Square
                </button>
                <button onClick={() => teleportShortcut('Eiffel Tower, Paris')} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-950/80 border border-zinc-800 hover:border-emerald-500/50 hover:bg-zinc-900 text-zinc-300 backdrop-blur-md transition-all">
                  🗼 Eiffel Tower
                </button>
                <button onClick={() => teleportShortcut('Shibuya Crossing, Tokyo')} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-950/80 border border-zinc-800 hover:border-emerald-500/50 hover:bg-zinc-900 text-zinc-300 backdrop-blur-md transition-all">
                  🍣 Shibuya Crossing
                </button>
                <button onClick={() => teleportShortcut('Colosseum, Rome')} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-950/80 border border-zinc-800 hover:border-emerald-500/50 hover:bg-zinc-900 text-zinc-300 backdrop-blur-md transition-all">
                  🏛️ Colosseum
                </button>
              </div>
            )}

            {/* Navigation Overlay bottom right */}
            <div className="absolute bottom-6 right-6 flex flex-col items-center bg-zinc-950/80 border border-zinc-800/85 p-3 rounded-2xl backdrop-blur-lg shadow-xl z-10 pointer-events-auto">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold mb-2 font-mono">Move Camera</span>
              <div className="grid grid-cols-3 gap-1.5">
                <div />
                <button 
                  onClick={() => triggerManualNavigate('forward')}
                  className="h-10 w-10 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-emerald-500/50 flex items-center justify-center text-zinc-300 transition-all active:scale-95"
                  title="Move Forward"
                >
                  <ChevronUp className="h-5 w-5" />
                </button>
                <div />

                <button 
                  onClick={() => triggerManualNavigate('left')}
                  className="h-10 w-10 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-emerald-500/50 flex items-center justify-center text-zinc-300 transition-all active:scale-95"
                  title="Turn Left"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <button 
                  onClick={() => triggerManualNavigate('around')}
                  className="h-10 w-10 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-emerald-500/50 flex items-center justify-center text-zinc-300 transition-all active:scale-95"
                  title="Turn Around"
                >
                  <RotateCcw className="h-4.5 w-4.5" />
                </button>
                <button 
                  onClick={() => triggerManualNavigate('right')}
                  className="h-10 w-10 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-emerald-500/50 flex items-center justify-center text-zinc-300 transition-all active:scale-95"
                  title="Turn Right"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>

                <div />
                <button 
                  onClick={() => triggerManualNavigate('backward')}
                  className="h-10 w-10 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-emerald-500/50 flex items-center justify-center text-zinc-300 transition-all active:scale-95"
                  title="Move Backward"
                >
                  <ChevronDown className="h-5 w-5" />
                </button>
                <div />
              </div>
            </div>
          </div>

          {/* Quick Settings Panel Popup inside Panorama */}
          {showSettings && (
            <div className="absolute top-18 right-4 w-72 rounded-xl bg-zinc-950/95 border border-zinc-800/90 p-4 shadow-2xl backdrop-blur-md z-20">
              <h3 className="text-sm font-semibold border-b border-zinc-800 pb-2 mb-3 text-emerald-400 flex items-center gap-1.5">
                <Settings className="h-4 w-4" /> Tour Configurations
              </h3>
              
              <div className="space-y-4 text-xs">
                {/* Audio source device selection */}
                <div>
                  <label className="block text-zinc-400 font-medium mb-1.5">Select Input Microphone</label>
                  <select 
                    value={selectedAudioSource}
                    onChange={(e) => setSelectedAudioSource(e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-200 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="default">Default System Mic</option>
                    {audioDevices.map(d => (
                      <option key={d.deviceId} value={d.deviceId}>{d.label || `Device (${d.deviceId.slice(0, 5)})`}</option>
                    ))}
                  </select>
                </div>

                {/* Auto-Chat delay setting */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-zinc-400 font-medium">Auto-Guide Trigger Silence</label>
                    <span className="text-emerald-400 font-mono">{(autoChatDelay / 1000).toFixed(1)}s</span>
                  </div>
                  <input 
                    type="range" 
                    min={1000} 
                    max={6000} 
                    step={500}
                    value={autoChatDelay}
                    onChange={(e) => setAutoChatDelay(Number(e.target.value))}
                    className="w-full accent-emerald-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                  />
                </div>

                {/* Playback speed selector */}
                <div>
                  <label className="block text-zinc-400 font-medium mb-1.5">AI Speaking Speed</label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {[0.8, 1.0, 1.2, 1.5].map(speed => (
                      <button
                        key={speed}
                        onClick={() => setPlaybackSpeed(speed)}
                        className={`py-1 rounded border transition-all ${
                          playbackSpeed === speed 
                            ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400 font-bold' 
                            : 'border-zinc-800 hover:border-zinc-700 text-zinc-400'
                        }`}
                      >
                        {speed.toFixed(1)}x
                      </button>
                    ))}
                  </div>
                </div>

                {/* Continuous tour toggler */}
                <div className="flex items-center justify-between border-t border-zinc-800 pt-3 mt-2">
                  <span className="text-zinc-400 font-medium">Proactive Guided Narration</span>
                  <button 
                    onClick={() => setIsContinuousTalking(!isContinuousTalking)}
                    className={`w-12 h-6.5 rounded-full p-1 transition-all ${isContinuousTalking ? 'bg-emerald-500' : 'bg-zinc-800'}`}
                  >
                    <div className={`h-4.5 w-4.5 rounded-full bg-zinc-950 transition-all transform ${isContinuousTalking ? 'translate-x-5.5' : 'translate-x-0'}`} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Right Section: Tour Transcript Log */}
        <section className="lg:col-span-4 bg-zinc-900/20 rounded-2xl border border-zinc-800/80 flex flex-col overflow-hidden shadow-2xl relative">
          
          {/* Transcript Box Header */}
          <div className="px-4 py-3 bg-zinc-900/60 border-b border-zinc-850 flex items-center justify-between">
            <span className="text-sm font-semibold tracking-tight text-zinc-300 flex items-center gap-1.5">
              <Activity className="h-4 w-4 text-emerald-400" /> Tour logs & Dialogue
            </span>
            {isAiSpeaking && (
              <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-medium animate-pulse">
                <Sparkles className="h-3.5 w-3.5 text-emerald-400 animate-spin-slow" /> Guide Speaking...
              </span>
            )}
          </div>

          {/* Dialog Log Scroll Container */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-zinc-950/20">
            {transcript.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center p-6 text-center text-zinc-500">
                <MapPin className="h-10 w-10 text-zinc-700 mb-3" />
                <p className="text-sm font-medium">Ready to start the tour.</p>
                <p className="text-xs text-zinc-600 mt-1">Press Start below to connect the live virtual guide.</p>
              </div>
            ) : (
              transcript.map(item => (
                <div 
                  key={item.id}
                  className={`flex flex-col ${item.role === 'user' ? 'items-end' : 'items-start'}`}
                >
                  <div className={`max-w-[85%] rounded-2xl p-3.5 text-sm shadow-md transition-all ${
                    item.role === 'user'
                      ? 'bg-emerald-600/10 border border-emerald-500/20 text-emerald-100 rounded-tr-none'
                      : item.text.startsWith('[System')
                      ? 'bg-zinc-900/30 border border-zinc-850 text-zinc-500 text-xs font-mono rounded-none w-full text-center'
                      : 'bg-zinc-800/60 border border-zinc-700/40 text-zinc-200 rounded-tl-none'
                  }`}>
                    {item.text}
                  </div>
                  <span className="text-[9px] text-zinc-600 font-mono mt-1 px-1">
                    {item.role === 'user' ? 'You' : 'Vista Guide'}
                  </span>
                </div>
              ))
            )}
            <div ref={transcriptEndRef} />
          </div>

          {/* sugestions for teleport inside text message */}
          {status === 'connected' && (
            <div className="px-3 py-2 bg-zinc-900/40 border-t border-zinc-850 flex gap-2 overflow-x-auto whitespace-nowrap scrollbar-none">
              <button 
                onClick={() => { setTextInput('Turn left and walk forward'); }}
                className="text-[10px] font-medium bg-zinc-900 border border-zinc-800 hover:border-emerald-500/30 text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded-md transition-all"
              >
                ↩️ "Turn left..."
              </button>
              <button 
                onClick={() => { setTextInput('Tell me what you see in front of us'); }}
                className="text-[10px] font-medium bg-zinc-900 border border-zinc-800 hover:border-emerald-500/30 text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded-md transition-all"
              >
                👀 "What do you see?"
              </button>
              <button 
                onClick={() => { setTextInput('Which direction should we go next?'); }}
                className="text-[10px] font-medium bg-zinc-900 border border-zinc-800 hover:border-emerald-500/30 text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded-md transition-all"
              >
                🗺️ "Where next?"
              </button>
            </div>
          )}

          {/* Text Message Input Bar */}
          <div className="p-3 border-t border-zinc-800 bg-zinc-950/80 flex items-center gap-2">
            <input 
              type="text"
              placeholder={status === 'connected' ? 'Ask guide something or type command...' : 'Offline... Click Start Session'}
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              disabled={status !== 'connected'}
              onKeyDown={(e) => { if (e.key === 'Enter') sendTextMessage(); }}
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1.5 focus:ring-emerald-500/30 focus:border-emerald-500/50 disabled:opacity-40 transition-all"
            />
            <button
              onClick={sendTextMessage}
              disabled={status !== 'connected' || !textInput.trim()}
              className="h-9 w-9 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-zinc-950 flex items-center justify-center shadow-lg shadow-emerald-600/10 active:scale-95 disabled:opacity-40 disabled:hover:bg-emerald-600 transition-all"
            >
              <Send className="h-4 w-4 text-zinc-950" />
            </button>
          </div>
        </section>
      </main>

      {/* Bottom Control Strip */}
      <footer className="h-20 border-t border-zinc-800 bg-zinc-900/80 flex items-center justify-between px-6 z-20">
        
        {/* Left Side: Mic state indicator */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsMicMuted(!isMicMuted)}
            disabled={status !== 'connected'}
            className={`h-11 w-11 rounded-2xl flex items-center justify-center border transition-all active:scale-95 disabled:opacity-45 ${
              isMicMuted 
                ? 'bg-rose-500/10 border-rose-500/30 text-rose-500 hover:bg-rose-500/20 shadow-lg shadow-rose-500/5' 
                : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 shadow-lg shadow-emerald-500/5'
            }`}
            title={isMicMuted ? 'Unmute microphone' : 'Mute microphone'}
          >
            {isMicMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5 animate-pulse" />}
          </button>
          <div className="text-xs">
            <span className="block text-zinc-400 font-medium">
              {isMicMuted ? 'Microphone Muted' : 'Microphone Listening'}
            </span>
            <span className="text-[10px] text-zinc-500 font-mono">
              {selectedAudioSource === 'default' ? 'Default system' : 'Selected microphone'}
            </span>
          </div>
        </div>

        {/* Center: Play/Stop session controller */}
        <div>
          {status === 'idle' ? (
            <button
              onClick={startSession}
              className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-zinc-950 font-extrabold px-8 py-3 rounded-2xl flex items-center gap-2.5 shadow-xl shadow-emerald-500/10 hover:shadow-emerald-500/20 transition-all transform hover:scale-[1.02] active:scale-[0.98]"
            >
              <Play className="h-5 w-5 fill-zinc-950 stroke-zinc-950" /> Start Guided Tour
            </button>
          ) : (
            <button
              onClick={stopSession}
              className="bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-400 hover:to-red-500 text-white font-extrabold px-8 py-3 rounded-2xl flex items-center gap-2.5 shadow-xl shadow-rose-500/10 hover:shadow-rose-500/20 transition-all transform hover:scale-[1.02] active:scale-[0.98]"
            >
              <Square className="h-4.5 w-4.5 fill-white stroke-white" /> End Guided Tour
            </button>
          )}
        </div>

        {/* Right Side: Proactive Speech / Auto-Chat Indicator status */}
        <div className="flex items-center gap-3">
          <div className="text-right text-xs">
            <span className="block text-zinc-400 font-medium">Proactive Guide</span>
            <span className="text-[10px] text-zinc-500 font-mono">
              {isContinuousTalking ? `Trigger in ${(autoChatDelay/1000).toFixed(0)}s silence` : 'Trigger on text only'}
            </span>
          </div>
          <div className={`h-11 w-11 rounded-2xl border flex items-center justify-center transition-all ${
            isContinuousTalking 
              ? 'bg-amber-500/10 border-amber-500/30 text-amber-500 shadow-lg shadow-amber-500/5' 
              : 'bg-zinc-800/40 border-zinc-800 text-zinc-500'
          }`}>
            <Sparkles className={`h-5 w-5 ${isContinuousTalking && status === 'connected' ? 'animate-spin-slow' : ''}`} />
          </div>
        </div>

      </footer>
    </div>
  );
}
