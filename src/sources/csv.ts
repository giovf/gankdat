// Sanity caps so a malformed/hostile body (one giant unquoted field, or an
// unclosed quote that never delimits) can't grow a single string until the
// isolate OOMs. Generous vs any real government CSV cell/row.
const MAX_FIELD_BYTES = 1_000_000;
const MAX_CELLS_PER_ROW = 2_000;

/**
 * Streaming RFC-4180 CSV rows from a response body: handles quoted fields,
 * escaped quotes, and embedded commas/newlines without buffering the file.
 * Shared by CSV-based sources (uk-sanctions UKSL, sam-exclusions extract) and, with
 * `delimiter = '\t'`, the tab-delimited Charity Commission extract.
 * Throws if a single field or row exceeds the sanity caps above.
 */
export async function* csvRows(
  body: ReadableStream<Uint8Array>,
  delimiter: string = ',',
): AsyncGenerator<string[]> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let pendingQuote = false;

  const endField = (): void => {
    if (row.length >= MAX_CELLS_PER_ROW) {
      throw new Error(`CSV row exceeded ${MAX_CELLS_PER_ROW} cells`);
    }
    row.push(field);
    field = '';
  };

  for (;;) {
    const { done, value } = await reader.read();
    const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
    for (const c of chunk) {
      if (inQuotes) {
        if (pendingQuote) {
          pendingQuote = false;
          if (c === '"') {
            field += '"';
            continue;
          }
          inQuotes = false; // the quote closed the field; c is a delimiter
        } else if (c === '"') {
          pendingQuote = true;
          continue;
        } else {
          field += c;
          continue;
        }
      }
      if (c === '"' && field === '') {
        inQuotes = true;
      } else if (c === delimiter) {
        endField();
      } else if (c === '\n') {
        endField();
        yield row;
        row = [];
      } else if (c !== '\r') {
        field += c;
      }
      if (field.length > MAX_FIELD_BYTES) {
        throw new Error(`CSV field exceeded ${MAX_FIELD_BYTES} bytes`);
      }
    }
    if (done) break;
  }
  if (field !== '' || row.length > 0) {
    endField();
    yield row;
  }
}
