/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/** Converts Uint8Array to base64 string for WebSocket transmission. */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Use spread: more efficient than loop concatenation for typical chunk sizes (~2–4KB).
  const binary = String.fromCharCode(...bytes);
  return btoa(binary);
}

const RECONNECT_MAX_RETRIES = 10;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 10000;

/**
 * Computes exponential backoff delay for reconnect attempts.
 * @param attempt Zero-based attempt index (0 = first retry)
 * @returns Delay in milliseconds, capped at RECONNECT_MAX_DELAY_MS
 */
export function getReconnectDelayMs(attempt: number): number {
  if (attempt < 0 || attempt >= RECONNECT_MAX_RETRIES) {
    return RECONNECT_MAX_DELAY_MS;
  }
  return Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt),
    RECONNECT_MAX_DELAY_MS
  );
}

/** Formats a transcript line for markdown logging. */
export function formatTranscriptLine(role: 'user' | 'model', text: string): string {
  const label = role === 'user' ? 'User' : 'Vista';
  return `**${label}**: ${text}\n`;
}
