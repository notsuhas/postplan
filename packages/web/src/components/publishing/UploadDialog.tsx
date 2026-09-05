import { useState } from 'react'
import type { SpaceSummary } from '@/lib/types'
import { DeployCard } from '@/components/publishing/DeployCard'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function UploadDialog(props: { spaces: SpaceSummary[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { spaces, open, onOpenChange } = props
  const [busy, setBusy] = useState(false)
  const changeOpen = (next: boolean) => {
    if (!next && busy) return
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-3xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Upload files</DialogTitle>
          <DialogDescription>Pick a destination, then drop your files.</DialogDescription>
        </DialogHeader>
        <DeployCard spaces={spaces} onBusyChange={setBusy} />
      </DialogContent>
    </Dialog>
  )
}
