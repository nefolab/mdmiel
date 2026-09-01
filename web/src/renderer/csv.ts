export const CSV_MAX_BYTES = 512 * 1024;
export const CSV_MAX_ROWS = 10_000;

export type CsvIssueKind = 'empty-header' | 'duplicate-header' | 'ragged-row' | 'empty-cell';

export type CsvIssue = {
  kind: CsvIssueKind;
  row?: number;
  column?: number;
};

export type CsvTable = {
  headers: string[];
  rows: string[][];
  issues: CsvIssue[];
  columnCount: number;
};

export type CsvParseOk = { ok: true; table: CsvTable };
export type CsvParseFail = {
  ok: false;
  reason: 'too-large' | 'too-many-rows' | 'parse-error' | 'empty';
  message: string;
};
export type CsvParseResult = CsvParseOk | CsvParseFail;

/**
 * RFC 4180 寄りのカンマ区切りパーサ。1行目をヘッダーとして診断する。
 * 壊れた行は捨てずに残し、issues に積む。
 */
export function parseCsv(content: string): CsvParseResult {
  const byteLength = new TextEncoder().encode(content).length;
  if (byteLength > CSV_MAX_BYTES) {
    return {
      ok: false,
      reason: 'too-large',
      message: `ファイルが ${byteLength} バイトあり、表表示の上限 ( 512KB ) を超えています`,
    };
  }

  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (text.length === 0) {
    return { ok: false, reason: 'empty', message: 'ファイルが空です' };
  }

  let records: string[][];
  try {
    records = parseRecords(text, CSV_MAX_ROWS + 1);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'CSVを解析できません';
    return { ok: false, reason: 'parse-error', message };
  }

  if (records.length === 0) {
    return { ok: false, reason: 'empty', message: 'ファイルが空です' };
  }
  if (records.length > CSV_MAX_ROWS) {
    return {
      ok: false,
      reason: 'too-many-rows',
      message: `行数が上限 ( ${CSV_MAX_ROWS}行 ) を超えています`,
    };
  }

  const headers = records[0];
  const rows = records.slice(1);
  const columnCount = records.reduce((max, record) => Math.max(max, record.length), 0);
  const issues: CsvIssue[] = [];
  const headerSeen = new Map<string, number>();

  headers.forEach((header, column) => {
    if (header === '') {
      issues.push({ kind: 'empty-header', row: 0, column });
      return;
    }
    const first = headerSeen.get(header);
    if (first !== undefined) {
      issues.push({ kind: 'duplicate-header', row: 0, column });
    } else {
      headerSeen.set(header, column);
    }
  });

  rows.forEach((row, rowIndex) => {
    if (row.length !== headers.length) {
      issues.push({ kind: 'ragged-row', row: rowIndex + 1 });
    }
    row.forEach((cell, column) => {
      if (cell === '') {
        issues.push({ kind: 'empty-cell', row: rowIndex + 1, column });
      }
    });
  });

  return { ok: true, table: { headers, rows, issues, columnCount } };
}

function parseRecords(text: string, maxRecords: number): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    records.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') {
        i += 1;
      }
      pushRow();
      if (records.length >= maxRecords) {
        return records;
      }
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (inQuotes) {
    throw new Error('引用符が閉じられていません');
  }

  if (field.length > 0 || row.length > 0) {
    pushRow();
  } else if (records.length === 0 && text.length > 0) {
    // 中身が改行だけなら空レコード1つ
    records.push(['']);
  }

  return records;
}

export function summarizeIssues(issues: CsvIssue[]): string {
  const counts = {
    'empty-header': 0,
    'duplicate-header': 0,
    'ragged-row': 0,
    'empty-cell': 0,
  };
  for (const issue of issues) {
    counts[issue.kind] += 1;
  }
  const parts: string[] = [];
  if (counts['empty-header'] > 0) parts.push(`空ヘッダー ${counts['empty-header']}`);
  if (counts['duplicate-header'] > 0) parts.push(`重複ヘッダー ${counts['duplicate-header']}`);
  if (counts['ragged-row'] > 0) parts.push(`列数不一致 ${counts['ragged-row']}行`);
  if (counts['empty-cell'] > 0) parts.push(`空セル ${counts['empty-cell']}`);
  return parts.join(' / ');
}

export function headerName(headers: string[], column: number): string {
  if (column < headers.length) return headers[column];
  return `列${column + 1}`;
}
