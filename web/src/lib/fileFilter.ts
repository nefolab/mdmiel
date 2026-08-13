export interface FileWithPath {
  path: string;
}

/** ファイルパス全体に検索語が含まれる項目だけを返す。 */
export function filterFiles<T extends FileWithPath>(files: T[], query: string): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery === '') return files;

  return files.filter((file) => file.path.toLowerCase().includes(normalizedQuery));
}

/** マッチしたファイルを表示するために展開が必要な祖先ディレクトリを返す。 */
export function getAncestorDirectories(files: FileWithPath[]): Set<string> {
  const directories = new Set<string>();

  files.forEach((file) => {
    const parts = file.path.split('/');
    let directoryPath = '';

    parts.slice(0, -1).forEach((part) => {
      directoryPath = directoryPath ? `${directoryPath}/${part}` : part;
      directories.add(directoryPath);
    });
  });

  return directories;
}
