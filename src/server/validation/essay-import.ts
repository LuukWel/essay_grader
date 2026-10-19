// Parsing and validation of an essay set CSV (data/subset_<NAME>.csv).
//
// File contract:
// - UTF-8, optional byte order mark. Comma-separated, first row is the header.
// - RFC 4180 quoting: a field wrapped in double quotes may contain commas, line breaks
//   and doubled quotes (""). A quote anywhere else in a field is an error.
// - Line endings may be LF or CRLF; line breaks inside a field are stored as LF.
// - Required columns: id, essay. Optional: prompt, word_count. Other columns are ignored.
//   Header names are case-insensitive.
// - Every row has exactly as many fields as the header. Blank lines are skipped.
// - id and essay are non-empty after trimming; ids are unique within the file.
// - word_count, when filled in, is a whole number; when empty it is counted from the text.
//
// All errors are collected with line numbers. Nothing is stored unless the whole file is valid.

export interface EssayRow {
  /** The dataset's own essay ID (the CSV `id` column). */
  sourceId: string;
  prompt: string | null;
  essay: string;
  wordCount: number;
  /** Line in the file where the row starts. */
  line: number;
}

export type ImportResult = { ok: true; rows: EssayRow[] } | { ok: false; errors: string[] };

interface CsvRecord {
  line: number;
  fields: string[];
}

export function parseEssayCsv(text: string): ImportResult {
  const { records, errors } = parseCsvRecords(text);
  if (records.length === 0) return { ok: false, errors: ['The file is empty'] };

  const [header, ...dataRecords] = records;
  const columns = header.fields.map((h) => h.trim().toLowerCase());
  const col = (name: string) => columns.indexOf(name);

  const missing = ['id', 'essay'].filter((name) => col(name) === -1);
  if (missing.length > 0) {
    return { ok: false, errors: [`Missing required column(s): ${missing.join(', ')}`, ...errors] };
  }
  if (dataRecords.length === 0) {
    return { ok: false, errors: ['The file has a header but no essays', ...errors] };
  }

  const rows: EssayRow[] = [];
  const firstLineOfId = new Map<string, number>();

  for (const { line, fields } of dataRecords) {
    if (fields.length !== columns.length) {
      errors.push(`Line ${line}: expected ${columns.length} fields, found ${fields.length}`);
      continue;
    }

    const sourceId = fields[col('id')].trim();
    const essay = fields[col('essay')].trim();
    const prompt = col('prompt') === -1 ? '' : fields[col('prompt')].trim();

    if (!sourceId) errors.push(`Line ${line}: id is empty`);
    if (!essay) errors.push(`Line ${line}: essay text is empty`);
    if (sourceId) {
      const first = firstLineOfId.get(sourceId);
      if (first !== undefined) errors.push(`Line ${line}: duplicate id "${sourceId}" (first used on line ${first})`);
      else firstLineOfId.set(sourceId, line);
    }

    let wordCount = essay.split(/\s+/).filter(Boolean).length;
    const rawCount = col('word_count') === -1 ? '' : fields[col('word_count')].trim();
    if (rawCount) {
      if (/^\d+$/.test(rawCount)) wordCount = Number(rawCount);
      else errors.push(`Line ${line}: word_count "${rawCount}" is not a whole number`);
    }

    rows.push({ sourceId, prompt: prompt || null, essay, wordCount, line });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, rows };
}

/** Splits CSV text into records, reporting quoting errors instead of guessing. */
export function parseCsvRecords(text: string): { records: CsvRecord[]; errors: string[] } {
  const records: CsvRecord[] = [];
  const errors: string[] = [];
  const error = (msg: string) => { if (!errors.includes(msg)) errors.push(msg); };

  let fields: string[] = [];
  let field = '';
  // start: at the beginning of a field; unquoted / quoted: inside one;
  // closed: just after the closing quote of a quoted field.
  let state: 'start' | 'unquoted' | 'quoted' | 'closed' = 'start';
  let line = 1;
  let recordLine = 1;

  const endField = () => {
    fields.push(field);
    field = '';
    state = 'start';
  };
  const endRecord = () => {
    endField();
    if (fields.some((v) => v.trim() !== '')) records.push({ line: recordLine, fields });
    fields = [];
  };

  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i];

    if (state === 'quoted') {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') state = 'closed';
      else if (c === '\r' || c === '\n') {
        // Store line breaks as "\n" so the text (and its offsets and hash) is the same on every platform.
        if (c === '\r' && text[i + 1] === '\n') i++;
        field += '\n';
        line++;
      } else field += c;
      continue;
    }

    if (c === ',') { endField(); continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      recordLine = line;
      continue;
    }

    if (state === 'closed') error(`Line ${line}: text after a closing quote`);
    else if (c === '"' && state === 'start') { state = 'quoted'; continue; }
    else if (c === '"') error(`Line ${line}: quote inside an unquoted field`);
    field += c;
    state = 'unquoted';
  }

  if (state === 'quoted') error(`Line ${recordLine}: quoted field is never closed`);
  else if (field !== '' || fields.length > 0) endRecord();

  return { records, errors };
}
