import { useState } from 'react'
import { Button } from '@/components/ui/button'

interface IImageView {
  src: string
  fileName: string
}

// fallow-ignore-next-line private-type-leak -- Component props are intentionally module-private.
export function ImageView(props: IImageView) {
  const { src, fileName } = props
  const [zoom, setZoom] = useState(1)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const downloadUrl = new URL(src)
  downloadUrl.searchParams.set('download', '1')

  return (
    <div className="flex size-full flex-col">
      <div
        className="flex flex-wrap items-center justify-center gap-2 border-b p-2"
        role="toolbar"
        aria-label="Image controls"
      >
        <Button
          variant="outline"
          size="sm"
          aria-label="Zoom out"
          disabled={zoom <= 0.25}
          onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}
        >
          −
        </Button>
        <span className="min-w-12 text-center text-sm" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <Button
          variant="outline"
          size="sm"
          aria-label="Zoom in"
          disabled={zoom >= 4}
          onClick={() => setZoom((value) => Math.min(4, value + 0.25))}
        >
          +
        </Button>
        <Button variant="outline" size="sm" onClick={() => setZoom(1)}>
          Fit to screen
        </Button>
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
      <section className="relative min-h-0 flex-1 overflow-auto" aria-label="Image preview">
        {status === 'loading' && (
          <p className="absolute inset-x-0 p-4 text-center text-sm" role="status">
            Loading image…
          </p>
        )}
        {status === 'error' && (
          <p className="absolute inset-x-0 p-4 text-center text-sm" role="alert">
            Could not load this image. Try opening the original.
          </p>
        )}
        <div
          className="flex items-center justify-center p-4"
          style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%`, minWidth: '100%', minHeight: '100%' }}
        >
          <img
            src={src}
            alt={fileName}
            className="block size-full object-contain"
            style={{
              display: status === 'error' ? 'none' : undefined,
              width: `${Math.min(zoom, 1) * 100}%`,
              height: `${Math.min(zoom, 1) * 100}%`,
            }}
            onLoad={() => setStatus('ready')}
            onError={() => setStatus('error')}
          />
        </div>
      </section>
    </div>
  )
}
