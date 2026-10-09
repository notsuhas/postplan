// Mirrors the content worker's EXT_MIME (packages/api/src/lib/mime.ts): the extension decides, not the stored MIME.
const KIND_BY_EXT: Record<string, FileKind> = {
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  ogg: 'audio',
  oga: 'audio',
  flac: 'audio',
  aac: 'audio',
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  webm: 'webm',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  svg: 'image',
  ico: 'image',
}

/** `webm` is a voice note or a video; only its metadata can tell. */
export type FileKind = 'audio' | 'video' | 'image' | 'webm' | 'document'

export function fileKindOf(path: string | null): FileKind {
  if (!path?.includes('.')) return 'document'
  return KIND_BY_EXT[(path.split('.').pop() ?? '').toLowerCase()] ?? 'document'
}
