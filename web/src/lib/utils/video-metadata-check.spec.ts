import { describe, expect, it } from 'vitest';
import { checkOriginalVideoMetadata } from './video-metadata-check';

function u32be(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n, false);
  return buf;
}

function u64be(n: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, n, false);
  return buf;
}

function ascii(text: string): Uint8Array {
  return new Uint8Array([...text].map((c) => c.charCodeAt(0)));
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// Builds a standard 32-bit-size box: 4-byte size + 4-byte ascii type + contents.
function box(type: string, ...contents: Uint8Array[]): Uint8Array {
  const body = concatBytes(contents);
  return concatBytes([u32be(8 + body.length), ascii(type), body]);
}

// Builds an mdat box using the 64-bit "largesize" encoding (size32 === 1).
function largesizeBox(type: string, ...contents: Uint8Array[]): Uint8Array {
  const body = concatBytes(contents);
  const totalSize = BigInt(16 + body.length);
  return concatBytes([u32be(1), ascii(type), u64be(totalSize), body]);
}

function toFile(bytes: Uint8Array, name = 'video.mp4'): File {
  return new File([bytes as BlobPart], name, { type: 'video/mp4' });
}

const FTYP = box('ftyp', ascii('isom'));
const DUMMY_MDAT = box('mdat', new Uint8Array(1024));

describe('checkOriginalVideoMetadata', () => {
  it('returns ok when classic ©mak/©mod atoms are present under udta', async () => {
    const moov = box('moov', box('udta', box('©mak', ascii('Apple')), box('©mod', ascii('iPhone'))));
    const file = toFile(concatBytes([FTYP, moov, DUMMY_MDAT]));

    await expect(checkOriginalVideoMetadata(file)).resolves.toBe('ok');
  });

  it('returns ok when moov is placed after mdat (order-independence)', async () => {
    const moov = box('moov', box('udta', box('©mak', ascii('Apple')), box('©mod', ascii('iPhone'))));
    const file = toFile(concatBytes([FTYP, DUMMY_MDAT, moov]));

    await expect(checkOriginalVideoMetadata(file)).resolves.toBe('ok');
  });

  it('returns ok for the modern Apple keyed-metadata scheme', async () => {
    const meta = box('meta', ascii('com.apple.quicktime.make'), ascii('com.apple.quicktime.model'));
    const moov = box('moov', meta);
    const file = toFile(concatBytes([FTYP, moov, DUMMY_MDAT]));

    await expect(checkOriginalVideoMetadata(file)).resolves.toBe('ok');
  });

  it('returns ok for the modern Android keyed-metadata scheme', async () => {
    const meta = box('meta', ascii('com.android.manufacturer'), ascii('com.android.model'));
    const moov = box('moov', meta);
    const file = toFile(concatBytes([FTYP, moov, DUMMY_MDAT]));

    await expect(checkOriginalVideoMetadata(file)).resolves.toBe('ok');
  });

  it('returns missing when moov has no Make/Model markers', async () => {
    const moov = box('moov', box('udta', box('©day', ascii('2024:01:01'))));
    const file = toFile(concatBytes([FTYP, moov, DUMMY_MDAT]));

    await expect(checkOriginalVideoMetadata(file)).resolves.toBe('missing');
  });

  it('returns parse-error when there is no moov box at all', async () => {
    const file = toFile(concatBytes([FTYP, DUMMY_MDAT]));

    await expect(checkOriginalVideoMetadata(file)).resolves.toBe('parse-error');
  });

  it('returns parse-error for a truncated/garbage file', async () => {
    const file = toFile(new Uint8Array([1, 2, 3]));

    await expect(checkOriginalVideoMetadata(file)).resolves.toBe('parse-error');
  });

  it('returns parse-error when moov declares a size overrunning the file', async () => {
    const bogusMoov = concatBytes([u32be(1_000_000), ascii('moov'), ascii('short')]);
    const file = toFile(concatBytes([FTYP, bogusMoov]));

    await expect(checkOriginalVideoMetadata(file)).resolves.toBe('parse-error');
  });

  it('returns ok when a preceding box uses the 64-bit largesize encoding', async () => {
    const bigMdat = largesizeBox('mdat', new Uint8Array(32));
    const moov = box('moov', box('udta', box('©mak', ascii('Apple')), box('©mod', ascii('iPhone'))));
    const file = toFile(concatBytes([FTYP, bigMdat, moov]));

    await expect(checkOriginalVideoMetadata(file)).resolves.toBe('ok');
  });
});
