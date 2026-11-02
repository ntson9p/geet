/**
 * What a revision of a binary file reads as in a diff. Its bytes decoded as text
 * are unreadable, and they are no use to a viewer asking whether two sides
 * differ, so the document says what it is instead. Pure and vscode-free.
 */

/** Git's own test for a binary file: a NUL within the first 8000 bytes. */
export function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes('\0');
}

/** `1,204 bytes`, `1.2 KB`, `3.4 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString('en-US')} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One line, with the object id: two versions of an image can have the same size,
 * and they must still read as different.
 */
export function binaryPlaceholder(bytes: number | undefined, objectId: string): string {
  const size = bytes !== undefined && Number.isFinite(bytes) ? `, ${formatSize(bytes)}` : '';
  return `Binary file${size} (${objectId})\n`;
}
