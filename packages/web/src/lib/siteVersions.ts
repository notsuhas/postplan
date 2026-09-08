export interface IVersionFile {
  path: string
  size: number | null
  etag: string | null
}

export interface ISiteVersion {
  version: number
  createdAt: string
  createdBy: string | null
  restoredFrom: number | null
  current: boolean
  files: IVersionFile[]
}

export function versionDiff(from: IVersionFile[], to: IVersionFile[]) {
  const previous = new Map(from.map((file) => [file.path, file]))
  const next = new Map(to.map((file) => [file.path, file]))
  const added = to.filter((file) => !previous.has(file.path)).map((file) => file.path)
  const removed = from.filter((file) => !next.has(file.path)).map((file) => file.path)
  const changed = to
    .filter((file) => {
      const old = previous.get(file.path)
      return old && (old.etag !== file.etag || old.size !== file.size)
    })
    .map((file) => file.path)
  return { added, removed, changed }
}
