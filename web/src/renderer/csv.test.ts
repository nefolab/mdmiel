import { describe, expect, it } from 'vitest';
import { CSV_MAX_BYTES, CSV_MAX_ROWS, headerName, parseCsv, summarizeIssues } from './csv';

describe('parseCsv', () => {
  it('treats the first record as headers', () => {
    const result = parseCsv('name,qty\npen,2\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.headers).toEqual(['name', 'qty']);
    expect(result.table.rows).toEqual([['pen', '2']]);
    expect(result.table.issues).toEqual([]);
  });

  it('keeps commas inside quoted fields', () => {
    const result = parseCsv('city,note\n"Anytown, WW",ok\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.rows[0]).toEqual(['Anytown, WW', 'ok']);
  });

  it('treats a quoted newline as one cell, not a new row', () => {
    const result = parseCsv('title,body\n"hello\nworld",x\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.rows).toHaveLength(1);
    expect(result.table.rows[0][0]).toBe('hello\nworld');
  });

  it('unescapes doubled quotes', () => {
    const result = parseCsv('a\n"ha ""ha"" ha"\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.rows[0][0]).toBe('ha "ha" ha');
  });

  it('strips a leading UTF-8 BOM', () => {
    const result = parseCsv('\uFEFFname,qty\npen,2\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.headers).toEqual(['name', 'qty']);
  });

  it('accepts CRLF record separators', () => {
    const result = parseCsv('a,b\r\n1,2\r\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.rows).toEqual([['1', '2']]);
  });

  it('does not treat a trailing newline as an extra empty row', () => {
    const result = parseCsv('a,b\n1,2\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.rows).toHaveLength(1);
  });

  it('records empty headers, duplicates, ragged rows, and empty cells', () => {
    const result = parseCsv(',name,name\n1,,\nonly\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const kinds = result.table.issues.map((issue) => issue.kind);
    expect(kinds).toContain('empty-header');
    expect(kinds).toContain('duplicate-header');
    expect(kinds).toContain('ragged-row');
    expect(kinds).toContain('empty-cell');
  });

  it('keeps a ragged row instead of dropping it', () => {
    const result = parseCsv('a,b\nonly\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.rows[0]).toEqual(['only']);
    expect(result.table.columnCount).toBe(2);
  });

  it('fails on an unclosed quote', () => {
    const result = parseCsv('a,b\n"oops\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('parse-error');
    expect(result.message).toContain('引用符');
  });

  it('fails on an empty file', () => {
    const result = parseCsv('');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty');
  });

  it('fails when the UTF-8 payload exceeds 512KB', () => {
    const result = parseCsv('x'.repeat(CSV_MAX_BYTES + 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too-large');
  });

  it('fails when the record count exceeds the row cap', () => {
    const lines = ['h', ...Array.from({ length: CSV_MAX_ROWS }, () => 'v')];
    const result = parseCsv(lines.join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too-many-rows');
  });
});

describe('headerName', () => {
  it('keeps an empty header empty instead of inventing a label', () => {
    expect(headerName(['name', ''], 1)).toBe('');
  });

  it('labels columns that do not exist on the header row', () => {
    expect(headerName(['name'], 1)).toBe('列2');
  });
});

describe('summarizeIssues', () => {
  it('joins counts in a stable order', () => {
    const result = parseCsv(',a,a\n1,\n2\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(summarizeIssues(result.table.issues)).toBe(
      '空ヘッダー 1 / 重複ヘッダー 1 / 列数不一致 2行 / 空セル 1'
    );
  });
});
