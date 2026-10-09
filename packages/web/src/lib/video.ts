// Mirrors the video EXT_MIME entries in packages/api/src/lib/mime.ts; .webm stays audio (voice notes) and is probed.
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov'])

function extOf(path: string): string {
  return path.includes('.') ? (path.split('.').pop() ?? '').toLowerCase() : ''
}

export function isVideoFile(path: string): boolean {
  return VIDEO_EXTENSIONS.has(extOf(path))
}

export function isWebmFile(path: string): boolean {
  return extOf(path) === 'webm'
}
