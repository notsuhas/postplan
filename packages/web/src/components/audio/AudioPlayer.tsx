import { type RefObject, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { AudioScrubber } from '@/components/audio/AudioScrubber'

// A compact player: a hidden `<audio src>` driven by our own AudioScrubber (native controls are
// replaced so the look matches the app). Hand-written; no vendored deps. Keying the root on `src`
// remounts the whole subtree — audio + scrubber together — when the source changes, so the element
// reliably reloads and the scrubber re-binds (a bare src swap on a live <audio> doesn't reliably
// reload). This is the single home for the remount contract — callers must NOT also key it.
// Callers may pass a shared `audioRef` to read/drive the same element (AudioView's timestamp seam);
// omit it for a self-contained player (the voice thread card).
export function AudioPlayer({
  src,
  audioRef,
  className,
  compact,
}: {
  src: string
  audioRef?: RefObject<HTMLAudioElement | null>
  className?: string
  // Tighter play button + readout for inline contexts (the voice comment card).
  compact?: boolean
}) {
  const internalRef = useRef<HTMLAudioElement>(null)
  const ref = audioRef ?? internalRef
  const [error, setError] = useState<string | null>(null)
  return (
    <div className={cn('flex w-full flex-col gap-2', className)}>
      {/* biome-ignore lint/a11y/useMediaCaption: audio-only source, no track to caption */}
      <audio
        key={src}
        ref={ref}
        src={src}
        preload="metadata"
        onCanPlay={() => setError(null)}
        onError={() => setError('This audio could not be loaded.')}
      />
      <AudioScrubber
        audioRef={ref}
        compact={compact}
        disabled={error !== null}
        onPlaybackError={() => setError('Playback was blocked or is not supported by this browser.')}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
