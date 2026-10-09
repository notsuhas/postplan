import { fileKindOf } from '@/lib/media'
import { useHasVideoTrack } from './useHasVideoTrack'

export type MediaKind = 'audio' | 'video' | 'image' | 'probing' | 'document'

export function useMediaKind(path: string | null, src: string): MediaKind {
  const kind = fileKindOf(path)
  const hasVideo = useHasVideoTrack(kind === 'webm' ? src : null)
  if (kind !== 'webm') return kind
  return hasVideo === null ? 'probing' : hasVideo ? 'video' : 'audio'
}
