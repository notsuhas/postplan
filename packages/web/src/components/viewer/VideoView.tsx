import { type RefObject, useState } from 'react'
import { Button } from '@/components/ui/button'

interface IVideoView {
  src: string
  fileName: string
  videoRef: RefObject<HTMLVideoElement | null>
}

// fallow-ignore-next-line private-type-leak -- Component props are intentionally module-private.
export function VideoView(props: IVideoView) {
  const { src, fileName, videoRef } = props
  const [failed, setFailed] = useState(false)
  const downloadUrl = new URL(src)
  downloadUrl.searchParams.set('download', '1')

  return (
    <div className="flex size-full flex-col">
      <div
        className="flex flex-wrap items-center justify-center gap-2 border-b p-2"
        role="toolbar"
        aria-label="Video controls"
      >
        <Button variant="outline" size="sm" asChild>
          <a href={src} target="_blank" rel="noreferrer">
            Open original
          </a>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href={downloadUrl.href} download={fileName}>
            Download
          </a>
        </Button>
      </div>
      <section className="flex min-h-0 flex-1 items-center justify-center p-4" aria-label="Video preview">
        {failed ? (
          <p className="text-center text-sm" role="alert">
            Could not play this video here. Try opening the original or downloading it.
          </p>
        ) : (
          // biome-ignore lint/a11y/useMediaCaption: uploaded files carry no caption track to point at.
          <video
            ref={videoRef}
            src={src}
            title={fileName}
            controls
            playsInline
            preload="metadata"
            className="block max-h-full max-w-full bg-black"
            onError={() => setFailed(true)}
          />
        )}
      </section>
    </div>
  )
}
