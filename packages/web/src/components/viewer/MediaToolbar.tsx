import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'

interface IMediaToolbar {
  src: string
  fileName: string
  label: string
  children?: ReactNode
}

// fallow-ignore-next-line private-type-leak -- Component props are intentionally module-private.
export function MediaToolbar(props: IMediaToolbar) {
  const { src, fileName, label, children } = props
  const downloadUrl = new URL(src)
  downloadUrl.searchParams.set('download', '1')

  return (
    <div className="flex flex-wrap items-center justify-center gap-2 border-b p-2" role="toolbar" aria-label={label}>
      {children}
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
  )
}
