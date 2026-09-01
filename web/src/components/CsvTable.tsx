import { headerName, parseCsv, summarizeIssues } from '../renderer/csv';

export function CsvTable({ content }: { content: string }) {
  const result = parseCsv(content);

  if (!result.ok) {
    return (
      <div className="csv-fallback">
        <div className="csv-banner" role="status">{result.message}</div>
        <pre className="csv-raw">{content}</pre>
      </div>
    );
  }

  const { headers, rows, issues, columnCount } = result.table;
  const summary = summarizeIssues(issues);
  const emptyHeader = new Set(
    issues.filter((issue) => issue.kind === 'empty-header').map((issue) => issue.column)
  );
  const duplicateHeader = new Set(
    issues.filter((issue) => issue.kind === 'duplicate-header').map((issue) => issue.column)
  );
  const emptyCells = new Set(
    issues
      .filter((issue) => issue.kind === 'empty-cell')
      .map((issue) => `${issue.row}:${issue.column}`)
  );
  const raggedRows = new Set(
    issues.filter((issue) => issue.kind === 'ragged-row').map((issue) => issue.row)
  );

  const columns = Array.from({ length: columnCount }, (_, column) => column);

  return (
    <div className="csv-preview">
      {summary && (
        <div className="csv-banner" role="status">CSVの問題: {summary}</div>
      )}
      <div className="csv-table-wrap">
        <table className="csv-table">
          <thead>
            <tr>
              <th className="csv-rownum" scope="col">#</th>
              {columns.map((column) => {
                const classes = [
                  emptyHeader.has(column) ? 'csv-cell-empty-header' : '',
                  duplicateHeader.has(column) ? 'csv-cell-duplicate-header' : '',
                ].filter(Boolean).join(' ');
                return (
                  <th key={column} scope="col" className={classes || undefined}>
                    {headerName(headers, column)}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => {
              const dataRow = rowIndex + 1;
              return (
                <tr key={rowIndex} className={raggedRows.has(dataRow) ? 'csv-row-ragged' : undefined}>
                  <th className="csv-rownum" scope="row">{dataRow}</th>
                  {columns.map((column) => {
                    if (column >= row.length) {
                      return <td key={column} className="csv-cell-missing" />;
                    }
                    const empty = emptyCells.has(`${dataRow}:${column}`);
                    return (
                      <td key={column} className={empty ? 'csv-cell-empty' : undefined}>
                        {row[column]}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
