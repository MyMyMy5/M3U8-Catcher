import { describe, it, expect } from "vitest";
import fc from "fast-check";

// ── Inlined helpers from popup/popup.js (not exported, heavy DOM deps) ──

const isArrayBufferLike = (value) => {
  const tag = Object.prototype.toString.call(value);
  return tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]";
};

const isBlobLike = (value) =>
  Object.prototype.toString.call(value) === "[object Blob]" ||
  (value && typeof value.arrayBuffer === "function" && typeof value.size === "number");

const normalizeWriteChunk = async (chunk) => {
  if (!chunk) return null;
  if (isBlobLike(chunk)) {
    const buffer = await chunk.arrayBuffer();
    return new Uint8Array(buffer);
  }
  if (isArrayBufferLike(chunk) || chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (chunk?.buffer && isArrayBufferLike(chunk.buffer)) {
    const offset = Number.isFinite(chunk.byteOffset) ? chunk.byteOffset : 0;
    const length = Number.isFinite(chunk.byteLength)
      ? chunk.byteLength
      : chunk.buffer.byteLength - offset;
    try {
      return new Uint8Array(chunk.buffer, offset, length);
    } catch (err) {
      return null;
    }
  }
  if (chunk?.type === "Buffer" && Array.isArray(chunk.data)) {
    return new Uint8Array(chunk.data);
  }
  if (chunk?.data && isArrayBufferLike(chunk.data)) {
    return new Uint8Array(chunk.data);
  }
  if (Array.isArray(chunk?.data)) {
    return new Uint8Array(chunk.data);
  }
  if (Array.isArray(chunk)) {
    return new Uint8Array(chunk);
  }
  if (typeof chunk === "object") {
    const keys = Object.keys(chunk).filter((key) => /^\d+$/.test(key));
    if (keys.length) {
      keys.sort((a, b) => Number(a) - Number(b));
      const maxIndex = Number(keys[keys.length - 1]);
      if (Number.isFinite(maxIndex)) {
        const out = new Uint8Array(maxIndex + 1);
        keys.forEach((key) => {
          const value = Number(chunk[key]);
          out[Number(key)] = Number.isFinite(value) ? value : 0;
        });
        return out;
      }
    }
  }
  return null;
};


// ── Helpers ─────────────────────────────────────────────────────────────

/** Assert that a Uint8Array matches the expected bytes. */
const expectSameBytes = (result, expected) => {
  expect(result).toBeInstanceOf(Uint8Array);
  expect(result.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(result[i]).toBe(expected[i]);
  }
};

/** Build a numeric-key object from a Uint8Array: { "0": b0, "1": b1, ... } */
const toNumericKeyObject = (bytes) => {
  const obj = {};
  for (let i = 0; i < bytes.length; i++) {
    obj[String(i)] = bytes[i];
  }
  return obj;
};

// ── Property 1: normalizeWriteChunk round-trip preserves bytes ──────────

describe("Feature: streaming-to-disk-downloads, Property 1: normalizeWriteChunk round-trip preserves bytes", () => {
  /**
   * **Validates: Requirements 8.1, 8.2, 8.3, 8.4**
   *
   * For any random byte array, wrapping it in each supported format and
   * passing through normalizeWriteChunk SHALL return a Uint8Array with
   * identical bytes.
   */

  it("preserves bytes when input is an ArrayBuffer", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 0, maxLength: 200 }),
        async (bytes) => {
          const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          const result = await normalizeWriteChunk(ab);
          expectSameBytes(result, bytes);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("preserves bytes when input is a Blob", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 200 }),
        async (bytes) => {
          const blob = new Blob([bytes]);
          const result = await normalizeWriteChunk(blob);
          expectSameBytes(result, bytes);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("preserves bytes when input is a Uint8Array", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 0, maxLength: 200 }),
        async (bytes) => {
          const result = await normalizeWriteChunk(bytes);
          expectSameBytes(result, bytes);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("preserves bytes when input is an Int8Array", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 200 }),
        async (bytes) => {
          const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          const int8 = new Int8Array(ab);
          const result = await normalizeWriteChunk(int8);
          expectSameBytes(result, bytes);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("preserves bytes when input is a Float64Array", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 25 }).chain((count) => {
          const byteLen = count * 8;
          return fc.uint8Array({ minLength: byteLen, maxLength: byteLen });
        }),
        async (bytes) => {
          const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          const f64 = new Float64Array(ab);
          const result = await normalizeWriteChunk(f64);
          expectSameBytes(result, bytes);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("preserves bytes when input is { type: 'Buffer', data: [...] }", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 200 }),
        async (bytes) => {
          const bufferLike = { type: "Buffer", data: Array.from(bytes) };
          const result = await normalizeWriteChunk(bufferLike);
          expectSameBytes(result, bytes);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("preserves bytes when input is a numeric-key object", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 200 }),
        async (bytes) => {
          const obj = toNumericKeyObject(bytes);
          const result = await normalizeWriteChunk(obj);
          expectSameBytes(result, bytes);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Edge case tests: invalid inputs return null ─────────────────────────

describe("normalizeWriteChunk edge cases: invalid inputs return null", () => {
  it("returns null for null", async () => {
    expect(await normalizeWriteChunk(null)).toBeNull();
  });

  it("returns null for undefined", async () => {
    expect(await normalizeWriteChunk(undefined)).toBeNull();
  });

  it("returns null for empty string", async () => {
    expect(await normalizeWriteChunk("")).toBeNull();
  });

  it("returns null for a number", async () => {
    expect(await normalizeWriteChunk(42)).toBeNull();
  });

  it("returns null for a boolean", async () => {
    expect(await normalizeWriteChunk(true)).toBeNull();
  });

  it("returns null for a plain empty object", async () => {
    expect(await normalizeWriteChunk({})).toBeNull();
  });
});
