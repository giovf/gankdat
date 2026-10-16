// Streaming ZIP unwrapping for single-file government extracts (SAM.gov,
// Charity Commission). Workers have DecompressionStream('deflate-raw') but no
// ZIP container support, so this parses the local file header of the FIRST
// entry and hands its deflate bytes to the inflater.

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_LOCAL_HEADER_LEN = 30;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_FLAG_DATA_DESCRIPTOR = 0x8;
const ZIP_DATA_DESCRIPTOR = 0x08074b50;
const ZIP_DESCRIPTOR_LEN = 16; // signature + crc32 + compressed size + uncompressed size

/**
 * Streams the raw deflate bytes of the first entry of a ZIP: parses the local
 * file header, skips name/extra, forwards exactly `compressed size` bytes and
 * drops the rest (data descriptor, further entries, central directory) so the
 * inflater never sees trailing bytes. When the ZIP uses a data descriptor
 * (sizes written AFTER the data — the Charity Commission extract does this),
 * the compressed size is unknown up front, so the stream is scanned for the
 * signed descriptor whose compressed-size field equals the bytes forwarded so
 * far (a false match needs a 4-byte signature AND that exact count, so it is
 * effectively impossible); everything from there on is dropped. Only method 8
 * (deflate) is supported; anything else is rejected loudly.
 */
/** Sizes learned while unwrapping (from the local header, or the data descriptor once found). */
export interface ZipEntrySizes {
  compressed?: number;
  uncompressed?: number;
}

export function zipFirstEntryDeflate(
  sizes: ZipEntrySizes = {},
): TransformStream<Uint8Array, Uint8Array> {
  let header = new Uint8Array(0);
  let skip = -1; // <0: header not parsed yet; otherwise bytes still to skip
  let remaining = Number.POSITIVE_INFINITY;
  let descriptorMode = false;
  let forwarded = 0; // compressed bytes emitted so far (descriptor csize must equal this)
  let tail = new Uint8Array(0); // last <16 bytes held back while scanning for the descriptor
  let ended = false;

  /** Descriptor scan: emit everything up to a descriptor whose csize matches, else keep a 15-byte tail. */
  const emitScanning = (
    input: Uint8Array,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    const buf = new Uint8Array(tail.length + input.length);
    buf.set(tail);
    buf.set(input, tail.length);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i + ZIP_DESCRIPTOR_LEN <= buf.length; i += 1) {
      if (
        view.getUint32(i, true) === ZIP_DATA_DESCRIPTOR &&
        view.getUint32(i + 8, true) === forwarded + i
      ) {
        if (i > 0) controller.enqueue(buf.subarray(0, i));
        forwarded += i;
        sizes.compressed = forwarded;
        sizes.uncompressed = view.getUint32(i + 12, true);
        ended = true;
        tail = new Uint8Array(0);
        return;
      }
    }
    const keep = Math.min(ZIP_DESCRIPTOR_LEN - 1, buf.length);
    const emit = buf.length - keep;
    if (emit > 0) {
      controller.enqueue(buf.subarray(0, emit));
      forwarded += emit;
    }
    tail = buf.slice(emit);
  };

  return new TransformStream({
    transform(chunk, controller) {
      if (ended) return;
      let buf = chunk;
      if (skip < 0) {
        const merged = new Uint8Array(header.length + buf.length);
        merged.set(header);
        merged.set(buf, header.length);
        header = merged;
        if (header.length < ZIP_LOCAL_HEADER_LEN) return;
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        if (view.getUint32(0, true) !== ZIP_LOCAL_HEADER) {
          controller.error(new Error('extract is not a ZIP'));
          return;
        }
        const flags = view.getUint16(6, true);
        const method = view.getUint16(8, true);
        if (method !== ZIP_METHOD_DEFLATE) {
          controller.error(new Error(`extract ZIP uses unsupported method ${method}`));
          return;
        }
        const compressedSize = view.getUint32(18, true);
        const nameLen = view.getUint16(26, true);
        const extraLen = view.getUint16(28, true);
        if ((flags & ZIP_FLAG_DATA_DESCRIPTOR) !== 0 || compressedSize === 0) {
          descriptorMode = true;
        } else {
          remaining = compressedSize;
          sizes.compressed = compressedSize;
          sizes.uncompressed = view.getUint32(22, true);
        }
        skip = ZIP_LOCAL_HEADER_LEN + nameLen + extraLen;
        buf = header;
        header = new Uint8Array(0);
      }
      if (skip > 0) {
        const n = Math.min(skip, buf.length);
        buf = buf.subarray(n);
        skip -= n;
      }
      if (buf.length === 0) return;
      if (descriptorMode) {
        emitScanning(buf, controller);
        return;
      }
      if (remaining <= 0) return;
      const take = Math.min(remaining, buf.length);
      controller.enqueue(buf.subarray(0, take));
      remaining -= take;
    },
    flush(controller) {
      if (skip < 0) {
        controller.error(new Error('extract ended before the ZIP header'));
        return;
      }
      // A data-descriptor entry that ends without its descriptor is truncated or corrupt.
      if (descriptorMode && !ended) {
        controller.error(
          new Error('ZIP entry ended without its data descriptor (truncated download?)'),
        );
      }
    },
  });
}

/** Caps the total bytes read from a stream, aborting past the limit. */
export function byteCapTransform(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) {
        controller.error(new Error(`decompressed body exceeded ${limit} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

/**
 * ZIP body → inflated bytes of its first entry, byte-capped. The unwrapper
 * stops exactly at the end of the entry (header size or verified data
 * descriptor), so the inflater never sees trailing bytes; when the entry's
 * uncompressed size is known the output length is verified against it, so a
 * truncated download fails instead of loading a partial dataset.
 */
export function inflateZipEntry(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  const sizes: ZipEntrySizes = {};
  const inflated = body
    .pipeThrough(zipFirstEntryDeflate(sizes))
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = inflated.getReader();
  let produced = 0;
  const verified = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if (sizes.uncompressed !== undefined && sizes.uncompressed !== produced) {
          controller.error(
            new Error(`ZIP entry inflated to ${produced} bytes, expected ${sizes.uncompressed}`),
          );
          return;
        }
        controller.close();
        return;
      }
      produced += value.byteLength;
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return verified.pipeThrough(byteCapTransform(maxBytes));
}
