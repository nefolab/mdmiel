export type FileKind = 'markdown' | 'html' | 'csv';

export function fileKindIcon(type: FileKind | undefined): string {
  if (type === 'markdown') return '📝';
  if (type === 'csv') return '📊';
  return '🌐';
}
