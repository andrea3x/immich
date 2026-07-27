const asciiBytes = (text: string): Uint8Array => new Uint8Array([...text].map((c) => c.charCodeAt(0)));

// Real-world device-identity marker presence checks. Not split by "make" vs "model" — vendors don't
// consistently separate the two (e.g. Samsung has no manufacturer field at all, just a device name
// and an internal model number), so this is a flat "any known identity marker present" check.
const DEVICE_IDENTITY_MARKERS: Uint8Array[] = [
  new Uint8Array([0xa9, 0x6d, 0x61, 0x6b]), // '©mak' - classic QuickTime (Apple)
  new Uint8Array([0xa9, 0x6d, 0x6f, 0x64]), // '©mod' - classic QuickTime (Apple)
  asciiBytes('com.apple.quicktime.make'),
  asciiBytes('com.apple.quicktime.model'),
  asciiBytes('com.android.manufacturer'), // stock Android / Google
  asciiBytes('com.android.model'),
  asciiBytes('manu'), // Google Open Spherical Camera API (HTC, 360-degree cameras)
  asciiBytes('modl'),
  asciiBytes('auth'), // Samsung proprietary udta scheme (device name)
  asciiBytes('mdln'), // Samsung proprietary udta scheme (model number, nested under smta)
  asciiBytes('smta'), // Samsung metadata container
  asciiBytes('cami'), // Samsung camera-info container
];

const MOOV_MAX_BYTES = 200 * 1024 * 1024; // sanity cap; real moov boxes are far smaller
const MAX_TOP_LEVEL_BOXES = 10_000; // defensive iteration guard, not expected to ever trigger

type BoxHeader = { type: string; start: number; size: number; contentStart: number };

async function readBoxHeader(file: File, offset: number): Promise<BoxHeader | 'eof' | 'invalid'> {
  if (offset >= file.size) {
    return 'eof';
  }

  const headBuf = await file.slice(offset, Math.min(offset + 16, file.size)).arrayBuffer();
  if (headBuf.byteLength < 8) {
    return 'invalid';
  }

  const view = new DataView(headBuf);
  const size32 = view.getUint32(0, false);
  const type = String.fromCharCode(view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7));

  if (size32 === 1) {
    if (headBuf.byteLength < 16) {
      return 'invalid';
    }
    const largesize = view.getBigUint64(8, false);
    if (largesize < 16n || largesize > BigInt(Number.MAX_SAFE_INTEGER)) {
      return 'invalid';
    }
    return { type, start: offset, size: Number(largesize), contentStart: offset + 16 };
  }

  if (size32 === 0) {
    return { type, start: offset, size: file.size - offset, contentStart: offset + 8 };
  }

  if (size32 < 8) {
    return 'invalid';
  }

  return { type, start: offset, size: size32, contentStart: offset + 8 };
}

async function findMoovContent(file: File): Promise<ArrayBuffer | 'not-found' | 'malformed'> {
  let offset = 0;
  for (let boxCount = 0; offset < file.size; boxCount++) {
    if (boxCount > MAX_TOP_LEVEL_BOXES) {
      return 'malformed';
    }

    const header = await readBoxHeader(file, offset);
    if (header === 'eof') {
      break;
    }
    if (header === 'invalid') {
      return 'malformed';
    }

    if (header.type === 'moov') {
      const boxEnd = header.start + header.size;
      if (boxEnd > file.size || boxEnd <= header.contentStart || boxEnd - header.contentStart > MOOV_MAX_BYTES) {
        return 'malformed';
      }
      return await file.slice(header.contentStart, boxEnd).arrayBuffer();
    }

    offset = header.start + header.size;
  }
  return 'not-found';
}

function containsSubsequence(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

// Returns 'ok', 'missing' (no device-identity marker found), or 'parse-error' (the moov box
// could not be conclusively located/read, e.g. a malformed or truncated container).
export async function checkOriginalVideoMetadata(file: File): Promise<'ok' | 'missing' | 'parse-error'> {
  try {
    const moov = await findMoovContent(file);
    if (moov === 'not-found' || moov === 'malformed') {
      return 'parse-error';
    }

    const bytes = new Uint8Array(moov);
    const hasIdentityMarker = DEVICE_IDENTITY_MARKERS.some((marker) => containsSubsequence(bytes, marker));
    return hasIdentityMarker ? 'ok' : 'missing';
  } catch {
    return 'parse-error';
  }
}
