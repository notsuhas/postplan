import { useEffect, useState } from 'react'

// Loads only metadata in a detached <video>: null while probing, false for audio-only or unreadable files.
export function useHasVideoTrack(src: string | null): boolean | null {
  const [result, setResult] = useState<{ src: string; hasVideo: boolean } | null>(null)

  useEffect(() => {
    if (!src) return
    const probe = document.createElement('video')
    probe.preload = 'metadata'
    probe.muted = true
    probe.onloadedmetadata = () => setResult({ src, hasVideo: probe.videoWidth > 0 })
    probe.onerror = () => setResult({ src, hasVideo: false })
    probe.src = src
    return () => {
      probe.onloadedmetadata = null
      probe.onerror = null
      probe.removeAttribute('src')
      probe.load()
    }
  }, [src])

  if (!src) return false
  return result?.src === src ? result.hasVideo : null
}
