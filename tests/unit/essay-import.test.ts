import { describe, expect, it } from 'vitest';
import { parseCsvRecords, parseEssayCsv } from '@/server/validation/essay-import';

const errorsOf = (text: string) => {
  const result = parseEssayCsv(text);
  return result.ok ? [] : result.errors;
};

describe('parseCsvRecords', () => {
  it('handles quoted commas, doubled quotes and line breaks inside quotes', () => {
    const { records, errors } = parseCsvRecords('a,b\n"x, y","say ""hi""\nthere"\n');
    expect(errors).toEqual([]);
    expect(records).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['x, y', 'say "hi"\nthere'] },
    ]);
  });

  it('numbers records by the line they start on, after multi-line fields and blank lines', () => {
    const { records } = parseCsvRecords('h\n"one\ntwo"\n\nthree\n');
    expect(records.map((r) => r.line)).toEqual([1, 2, 5]);
  });

  it('strips a byte order mark and accepts CRLF line endings', () => {
    const { records } = parseCsvRecords('﻿id,essay\r\nA,text\r\n');
    expect(records).toEqual([
      { line: 1, fields: ['id', 'essay'] },
      { line: 2, fields: ['A', 'text'] },
    ]);
  });

  it('stores line breaks inside a field as LF, whatever the file uses', () => {
    // A Windows checkout (core.autocrlf) turns the file's line endings into CRLF.
    const lf = 'id,essay\nA,"line one\nline two"\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    const oldMac = lf.replace(/\n/g, '\r');
    for (const text of [lf, crlf, oldMac]) {
      expect(parseCsvRecords(text).records[1]).toEqual({ line: 2, fields: ['A', 'line one\nline two'] });
    }
  });

  it.each([
    ['an unclosed quote', 'a\n"never closed\n', 'Line 2: quoted field is never closed'],
    ['a quote inside an unquoted field', 'a\nab"c\n', 'Line 2: quote inside an unquoted field'],
    ['text after a closing quote', 'a\n"ab"c\n', 'Line 2: text after a closing quote'],
  ])('reports %s', (_, text, expected) => {
    expect(parseCsvRecords(text).errors).toEqual([expected]);
  });
});

describe('parseEssayCsv', () => {
  it('returns rows with counted or given word counts', () => {
    const result = parseEssayCsv('id,prompt,essay,word_count\nA,P,one two three,\nB,,four five,10\n');
    expect(result).toEqual({
      ok: true,
      rows: [
        { sourceId: 'A', prompt: 'P', essay: 'one two three', wordCount: 3, line: 2 },
        { sourceId: 'B', prompt: null, essay: 'four five', wordCount: 10, line: 3 },
      ],
    });
  });

  it.each([
    ['an empty file', '', 'The file is empty'],
    ['a file with only blank lines', '\n\n', 'The file is empty'],
    ['a header without rows', 'id,essay\n', 'The file has a header but no essays'],
    ['a missing essay column', 'id,text\nA,hello\n', 'Missing required column(s): essay'],
    ['a non-numeric word_count', 'id,essay,word_count\nA,hello,ten\n', 'Line 2: word_count "ten" is not a whole number'],
  ])('rejects %s', (_, text, expected) => {
    expect(errorsOf(text)).toContain(expected);
  });

  it('accepts header names in any case', () => {
    expect(parseEssayCsv('ID,Essay\nA,hello\n').ok).toBe(true);
  });
});
