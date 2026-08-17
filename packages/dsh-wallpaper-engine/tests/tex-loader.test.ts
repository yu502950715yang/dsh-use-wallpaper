import { describe, expect, it } from 'vitest';
import { parseTex, glFormatForDds } from '../src/client/tex-loader.js';
import { makeTex } from './fixtures/make-tex.js';

describe('glFormatForDds', () => {
  it('maps fourCC to GL compressed formats', () => {
    expect(glFormatForDds('DXT1')).toBe(0x83f1);
    expect(glFormatForDds('DXT5')).toBe(0x83f3);
    expect(glFormatForDds('BC5U')).toBe(0x8fbd);
    expect(glFormatForDds('????')).toBe(0);
  });
});

describe('parseTex', () => {
  it('extracts dds bytes and dimensions', () => {
    const buf = makeTex(64, 32, 'DXT1', new Uint8Array(64 * 32 / 2).fill(0xff));
    const info = parseTex(buf)!;
    expect(info.width).toBe(64);
    expect(info.height).toBe(32);
    expect(info.glFormat).toBe(0x83f1);
    expect(info.dds.byteLength).toBe(128 + 64 * 32 / 2);
  });
  it('returns null for non-tex or non-compressed payloads', () => {
    expect(parseTex(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
