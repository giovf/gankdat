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

const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL = 0x06054b50;
const ZIP_METHOD_STORED = 0;

/** One entry of a ZIP as the walker hands it over: still compressed, with where the next one starts. */
export interface ZipMember {
  name: string;
  /** 8 = deflate (inflate with `inflateRaw`), 0 = stored. */
  method: number;
  /** The entry's bytes exactly as stored in the ZIP. */
  data: Uint8Array;
  uncompressedSize: number;
  /** Byte offset of this entry's local header in the ZIP. */
  offset: number;
  /** Byte offset of the next local header — where a later read resumes. */
  next: number;
}

export interface ZipWalkOptions {
  /** Reads bytes `[start, end)` of the ZIP (an HTTP Range read); may return fewer at the end of the file. */
  read(start: number, end: number): Promise<Uint8Array>;
  /** Total size of the ZIP in bytes. */
  size: number;
  /** Local-header offset to start from (0, or a previous member's `next`). */
  offset?: number;
  /** Bytes asked per read (default 8 MiB). */
  sliceBytes?: number;
}

/**
 * Walks a many-member ZIP entry by entry from any local-header offset, reading it in Range
 * slices (uk-company-accounts, 2026-11-13: Companies House's daily accounts ZIP holds
 * 8,000–80,000 iXBRL files in 60–600 MiB, far past one request's memory and one wave's budget).
 * Each member is yielded whole with the offset of the next header, so the caller can stop
 * after any member and resume there on a later run; the walk ends at the central directory.
 * Requires sizes in the local header (general-purpose flag bit 3 clear — the data-descriptor
 * form needs the scan `zipFirstEntryDeflate` does and is rejected here) and no ZIP64 entry.
 */
export async function* zipMembers(options: ZipWalkOptions): AsyncGenerator<ZipMember> {
  const slice = options.sliceBytes ?? 8 * 1024 * 1024;
  let position = options.offset ?? 0; // offset of buffer[0] in the ZIP
  let buffer: Uint8Array = new Uint8Array(0);
  let fetched = position; // first byte not yet read

  /** Grows the buffer until it holds `need` bytes; false when the file ends first. */
  const ensure = async (need: number): Promise<boolean> => {
    while (buffer.length < need) {
      if (fetched >= options.size) return false;
      const end = Math.min(options.size, fetched + Math.max(slice, need - buffer.length));
      const chunk = await options.read(fetched, end);
      if (chunk.length === 0) return false;
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer);
      merged.set(chunk, buffer.length);
      buffer = merged;
      fetched += chunk.length;
    }
    return true;
  };

  for (;;) {
    if (!(await ensure(ZIP_LOCAL_HEADER_LEN))) {
      if (buffer.length === 0) return; // clean end of file (a ZIP cut exactly at a header)
      throw new Error(`ZIP ended inside a header at byte ${position}`);
    }
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const signature = view.getUint32(0, true);
    if (signature === ZIP_CENTRAL_HEADER || signature === ZIP_END_OF_CENTRAL) return;
    if (signature !== ZIP_LOCAL_HEADER) {
      throw new Error(`no ZIP entry at byte ${position} (signature ${signature.toString(16)})`);
    }
    const flags = view.getUint16(6, true);
    const method = view.getUint16(8, true);
    const compressedSize = view.getUint32(18, true);
    const uncompressedSize = view.getUint32(22, true);
    const nameLen = view.getUint16(26, true);
    const extraLen = view.getUint16(28, true);
    if ((flags & ZIP_FLAG_DATA_DESCRIPTOR) !== 0) {
      throw new Error(`ZIP entry at byte ${position} uses a data descriptor (not walkable)`);
    }
    if (compressedSize === 0xffffffff) {
      throw new Error(`ZIP entry at byte ${position} is ZIP64 (not supported)`);
    }
    if (method !== ZIP_METHOD_DEFLATE && method !== ZIP_METHOD_STORED) {
      throw new Error(`ZIP entry at byte ${position} uses unsupported method ${method}`);
    }
    const dataStart = ZIP_LOCAL_HEADER_LEN + nameLen + extraLen;
    const total = dataStart + compressedSize;
    if (!(await ensure(total))) {
      throw new Error(`ZIP ended inside the entry at byte ${position} (truncated download?)`);
    }
    const name = new TextDecoder().decode(
      buffer.subarray(ZIP_LOCAL_HEADER_LEN, ZIP_LOCAL_HEADER_LEN + nameLen),
    );
    const offset = position;
    position += total;
    yield {
      name,
      method,
      data: buffer.subarray(dataStart, total),
      uncompressedSize,
      offset,
      next: position,
    };
    buffer = buffer.subarray(total);
  }
}

/** Inflates one member's raw deflate bytes (`ZipMember.data` of method 8), capped at `maxBytes`. */
export async function inflateRaw(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const inflated = new Response(data).body!.pipeThrough(new DecompressionStream('deflate-raw'));
  const out = await new Response(inflated.pipeThrough(byteCapTransform(maxBytes))).arrayBuffer();
  return new Uint8Array(out);
}
