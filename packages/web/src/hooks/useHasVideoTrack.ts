import { useEffect, useState } from 'react'

// Some browsers never load metadata without a user gesture; after this, treat the file as audio.
const PROBE_TIMEOUT_MS = 5000

// Loads only metadata in a detached <video>: null while probing, false for audio-only or unreadable files.
export function useHasVideoTrack(src: string | null): boolean | null {
  const [result, setResult] = useState<{ src: string; hasVideo: boolean } | null>(null)

  useEffect(() => {
    if (!src) return
    const probe = document.createElement('video')
    probe.preload = 'metadata'
    probe.muted = true
    // First answer wins, so a late load can't swap the player mid-playback.
    let settled = false
    const settle = (hasVideo: boolean) => {
      if (settled) return
      settled = true
      setResult({ src, hasVideo })
    }
    probe.onloadedmetadata = () => settle(probe.videoWidth > 0)
    probe.onerror = () => settle(false)
    const timer = setTimeout(() => settle(false), PROBE_TIMEOUT_MS)
    probe.src = src
    return () => {
      clearTimeout(timer)
      probe.onloadedmetadata = null
      probe.onerror = null
      probe.removeAttribute('src')
      probe.load()
    }
  }, [src])

  if (!src) return false
  return result?.src === src ? result.hasVideo : null
}
