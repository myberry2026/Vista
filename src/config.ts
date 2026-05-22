/**
 * Application Configuration
 * 
 * Centralized configuration file for the Vista frontend application.
 * Values here can be wired up to Feature Flags (e.g., LaunchDarkly, Statsig)
 * or environment variables (import.meta.env) in the future.
 */

export const CONFIG = {
  // ============================================================================
  // Session & Connection Settings
  // ============================================================================
  
  /**
   * The duration (in milliseconds) of silence required before Vista
   * automatically disconnects the Gemini Live session to save tokens/bandwidth
   * when Auto-Chat mode is turned OFF.
   * Default: 60000 ms (1 minute)
   */
  AUTO_DISCONNECT_SILENCE_MS: 60000,
  
  RECONNECT_MAX_RETRIES: 10,
  RECONNECT_BASE_DELAY_MS: 1000,
  RECONNECT_MAX_DELAY_MS: 10000,
  DEFAULT_AUTO_CHAT_ENABLED: true,
  REC_MIC_BOOST: 1.5,
  REC_AI_BOOST: 1.5,
  DUCKED_MIC_GAIN: 0.01,

  // ============================================================================
  // UI & Feature Flags
  // ============================================================================
  
  /**
   * If true, shows a checkbox in the UI allowing the user to disable the recording watermark.
   * If false, the watermark is ALWAYS applied during screen recordings without the option to disable it.
   * Default: false
   */
  ENABLE_WATERMARK_TOGGLE: false,

  // ============================================================================
  // Media Streaming Settings
  // ============================================================================

  /**
   * Audio sample rate required by Gemini Live API.
   * Default: 16000
   */
  AUDIO_SAMPLE_RATE: 16000,

  /**
   * Internal buffer size for the AudioWorkletProcessor.
   * 2048 at 16000Hz = ~128ms of audio per WebSocket message.
   */
  AUDIO_BUFFER_SIZE: 2048,

  /**
   * Maximum dimension (width or height) for video frames sent to Gemini.
   * Higher values use more tokens; lower values reduce token consumption.
   * Default: 480
   */
  VIDEO_FRAME_MAX_DIMENSION: 480,

  /**
   * How often (in ms) to send a video frame to the Gemini Live session.
   * Default: 2000 ms (1 frame every 2 seconds)
   */
  VIDEO_FRAME_INTERVAL_MS: 2000,

  // ============================================================================
  // Timing & API Limits
  // ============================================================================

  /**
   * How often (in ms) to poll the audio queue to check for continuous silence.
   * Default: 200
   */
  SILENCE_CHECK_INTERVAL_MS: 200,

  /**
   * The threshold of context tokens that triggers the Context Window Compression.
   * Must be passed as a string to the API.
   * Default: "80000"
   */
  CONTEXT_WINDOW_TRIGGER_TOKENS: "80000",

  /**
   * The target amount of tokens to compress down to during Context Window Compression.
   * Must be passed as a string to the API.
   * Default: "40000"
   */
  CONTEXT_WINDOW_TARGET_TOKENS: "40000",
};
