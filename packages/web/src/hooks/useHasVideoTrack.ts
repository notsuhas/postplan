import { useEffect, useState } from 'react'

// Loads only metadata in a detached <video> and reports whether the source has a picture.
export function useHasVideoTrack(src: string | null): boolean {
  const [result, setResult] = useState<{ src: string; hasVideo: boolean } | null>(null)

  useEffect(() => {
    if (!src) return
    const probe = document.createElement('video')
    probe.preload = 'metadata'
    probe.muted = true
    probe.onloadedmetadata = () => setResult({ src, hasVideo: probe.videoWidth > 0 })
    probe.src = src
    return () => {
      probe.onloadedmetadata = null
      probe.removeAttribute('src')
      probe.load()
    }
  }, [src])

  return result?.src === src && result.hasVideo
}
