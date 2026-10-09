import type { RefObject } from 'react'
import { Spinner } from '@/components/ui/states'
import type { MediaKind } from '@/hooks/useMediaKind'
import { AudioView } from './AudioView'
import { ImageView } from './ImageView'
import { VideoView } from './VideoView'

interface IMediaPane {
  kind: Exclude<MediaKind, 'document'>
  src: string
  fileName: string
  audioRef: RefObject<HTMLAudioElement | null>
  videoRef: RefObject<HTMLVideoElement | null>
}

// fallow-ignore-next-line private-type-leak -- Component props are intentionally module-private.
export function MediaPane(props: IMediaPane) {
  const { kind, src, fileName, audioRef, videoRef } = props
  switch (kind) {
    case 'probing':
      return (
        <div className="flex size-full items-center justify-center">
          <Spinner className="size-6" />
        </div>
      )
    case 'audio':
      return <AudioView src={src} fileName={fileName} audioRef={audioRef} />
    case 'video':
      return <VideoView key={src} src={src} fileName={fileName} videoRef={videoRef} />
    case 'image':
      return <ImageView key={src} src={src} fileName={fileName} />
  }
}
