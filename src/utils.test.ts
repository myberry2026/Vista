import { describe, it, expect } from 'vitest';
import { uint8ArrayToBase64, getReconnectDelayMs, formatTranscriptLine } from './utils';

describe('uint8ArrayToBase64', () => {
  it('converts empty Uint8Array to empty base64', () => {
    expect(uint8ArrayToBase64(new Uint8Array())).toBe('');
  });

  it('converts bytes to correct base64 string', () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]);
    expect(uint8ArrayToBase64(bytes)).toBe('SGVsbG8=');
  });

  it('converts binary data correctly', () => {
    const bytes = new Uint8Array([0, 1, 255, 128]);
    const result = uint8ArrayToBase64(bytes);
    expect(atob(result)).toBe(String.fromCharCode(0, 1, 255, 128));
  });

  it('round-trips with atob', () => {
    const original = 'Hello, World!';
    const encoder = new TextEncoder();
    const bytes = encoder.encode(original);
    const b64 = uint8ArrayToBase64(bytes);
    expect(atob(b64)).toBe(original);
  });
});

describe('getReconnectDelayMs', () => {
  it('returns 1000ms for first attempt (attempt 0)', () => {
    expect(getReconnectDelayMs(0)).toBe(1000);
  });

  it('doubles delay for each attempt', () => {
    expect(getReconnectDelayMs(1)).toBe(2000);
    expect(getReconnectDelayMs(2)).toBe(4000);
  });

  it('caps delay at 10000ms', () => {
    expect(getReconnectDelayMs(5)).toBe(10000);
    expect(getReconnectDelayMs(10)).toBe(10000);
  });

  it('handles invalid attempt numbers', () => {
    expect(getReconnectDelayMs(-1)).toBe(10000);
  });
});

describe('formatTranscriptLine', () => {
  it('formats user role correctly', () => {
    expect(formatTranscriptLine('user', 'Hello!')).toBe('**User**: Hello!\n');
  });

  it('formats model role correctly', () => {
    expect(formatTranscriptLine('model', 'Hi there!')).toBe('**Vista**: Hi there!\n');
  });

  it('handles empty text', () => {
    expect(formatTranscriptLine('user', '')).toBe('**User**: \n');
  });

  it('preserves multi-line and special chars', () => {
    const text = 'Line 1\nLine 2';
    expect(formatTranscriptLine('model', text)).toBe('**Vista**: Line 1\nLine 2\n');
  });
});
