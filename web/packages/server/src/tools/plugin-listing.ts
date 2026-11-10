/** TAL-2129: Settings › Tools › Plugins' filter. Keeps rows whose name (else key) or description contains `q`, case-insensitively; `total` and `empty` describe every row. */
export function pluginListing<T extends { key: string; name?: string | undefined; description?: string | undefined }>(rows: T[], q = ''): { plugins: T[]; total: number; empty: boolean } {
  const needle = q.trim().toLowerCase()
  const plugins = needle ? rows.filter((row) => [row.name || row.key, row.description ?? ''].some((text) => text.toLowerCase().includes(needle))) : rows
  return { plugins, total: rows.length, empty: rows.length === 0 }
}
