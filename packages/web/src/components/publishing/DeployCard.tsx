import { useEffect, useRef, useState } from 'react'
import { useRevalidator } from 'react-router'
import { ExternalLink, FolderUp, UploadCloud } from 'lucide-react'
import { toast } from 'sonner'
import { CopyButton } from '@/components/ui/CopyButton'
import { SpaceSelect } from '@/components/spaces/SpaceSelect'
import { Spinner } from '@/components/ui/states'
import { VisibilityMenu } from '@/components/sites/visibility'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import type { SlugExists, SpaceSummary, Visibility } from '@/lib/types'
import { type DroppedFile, filesFromDataTransfer, filesFromInput } from '@/lib/walkFiles'
import { slugify } from '@/lib/slug'
import { defaultSpaceSlug } from '@/lib/spaces'
import { uploadFiles } from '@/lib/uploadWithProgress'
import { cn } from '@/lib/utils'

interface IUploadTarget {
  space: string
  slug: string
  visibility: Visibility
}

type UploadState =
  | { phase: 'idle' }
  | { phase: 'preparing'; files: DroppedFile[]; target: IUploadTarget }
  | { phase: 'uploading'; pct: number; count: number }
  | { phase: 'done'; url: string }
  | { phase: 'error'; message: string; files: DroppedFile[] }

interface IUploadAttempt {
  target: IUploadTarget
  files: DroppedFile[]
  replace: boolean
}

interface IPendingReplace {
  target: IUploadTarget
  files: DroppedFile[]
}

const targetKey = (target: Pick<IUploadTarget, 'space' | 'slug'>): string => `${target.space}\0${target.slug}`

// Guess a slug from what was dropped: the top folder name, or — for loose files —
// any one file's name with its extension stripped. Pre-fills the input so the user
// can tweak it before deploying.
function deriveSlug(files: DroppedFile[]): string {
  const path = files[0]?.path ?? ''
  const [top, ...rest] = path.split('/')
  const base = rest.length > 0 ? top : (top ?? '').replace(/\.[^.]+$/, '')
  return slugify(base ?? '')
}

// Drop a folder → get a URL. Renders chrome-free (no outer card/heading) — the record-first
// dashboard embeds it in the UploadDialog, which supplies its own title/description.
export function DeployCard(props: { spaces: SpaceSummary[]; onBusyChange?: (busy: boolean) => void }) {
  const { spaces, onBusyChange } = props
  const revalidator = useRevalidator()
  const folderInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  // Slug-conflict probe. MUST use the `api` helper, not useFetcher().load() — `/api/*`
  // has no client route, so a fetcher.load matches the `*` not-found splat and throws a
  // 404 into the AppShell error boundary (renders the 404 page, URL stuck on /dashboard).
  const checkSeq = useRef(0)
  const preparingRef = useRef(false)
  const uploadAbortRef = useRef<AbortController | null>(null)

  const [space, setSpace] = useState(() => defaultSpaceSlug(spaces))
  const [slug, setSlug] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('team')
  const [dragActive, setDragActive] = useState(false)
  const [upload, setUpload] = useState<UploadState>({ phase: 'idle' })
  // Controlled replace-confirm: holds the files awaiting an overwrite decision.
  const [pendingReplace, setPendingReplace] = useState<IPendingReplace | null>(null)
  // Files dropped before a slug was set — held until the user confirms via Deploy.
  const [staged, setStaged] = useState<DroppedFile[] | null>(null)

  const [conflict, setConflict] = useState<{ key: string; value: SlugExists } | null>(null)
  const [checkError, setCheckError] = useState(false)
  const [checking, setChecking] = useState(false)
  const currentTarget = { space, slug, visibility }
  const currentConflict = conflict?.key === targetKey(currentTarget) ? conflict.value : null
  const takenByOther = currentConflict?.exists === true && currentConflict.owned === false
  const ownedConflict = currentConflict?.exists === true && currentConflict.owned === true
  const available = currentConflict?.exists === false

  const busy = upload.phase === 'preparing' || upload.phase === 'uploading'
  const locked = busy
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  useEffect(
    () => () => {
      checkSeq.current += 1
      uploadAbortRef.current?.abort()
      onBusyChange?.(false)
    },
    [onBusyChange],
  )

  function invalidateConflict() {
    checkSeq.current += 1
    setChecking(false)
    setConflict(null)
    setCheckError(false)
  }

  async function probeTarget(target: IUploadTarget): Promise<SlugExists | null> {
    if (!target.slug || !target.space) return null
    const seq = ++checkSeq.current
    setChecking(true)
    setCheckError(false)
    try {
      const result = await api.get<SlugExists>(`/api/sites/${target.space}/${target.slug}/exists`)
      if (seq !== checkSeq.current) return null
      setConflict({ key: targetKey(target), value: result })
      return result
    } catch (error) {
      if (seq !== checkSeq.current) return null
      setConflict(null)
      setCheckError(true)
      throw error
    } finally {
      if (seq === checkSeq.current) setChecking(false)
    }
  }

  function checkSlug(target: IUploadTarget = currentTarget) {
    void probeTarget(target).catch(() => {})
  }

  async function doUpload(attempt: IUploadAttempt) {
    if (uploadAbortRef.current) return
    const controller = new AbortController()
    uploadAbortRef.current = controller
    onBusyChange?.(true)
    setStaged(null)
    setUpload({ phase: 'uploading', pct: 0, count: attempt.files.length })
    try {
      const res = await uploadFiles(`/api/upload/${attempt.target.space}/${attempt.target.slug}`, attempt.files, {
        visibility: attempt.target.visibility,
        replace: attempt.replace,
        signal: controller.signal,
        onProgress: (pct) => {
          if (!controller.signal.aborted) {
            setUpload({ phase: 'uploading', pct, count: attempt.files.length })
          }
        },
      })
      setUpload({ phase: 'done', url: res.url })
      setConflict({ key: targetKey(attempt.target), value: { exists: true, owned: true } })
      toast.success('Deployed', { description: res.url })
      revalidator.revalidate()
    } catch (err) {
      if (controller.signal.aborted) return
      const message = err instanceof Error ? err.message : 'Upload failed'
      setUpload({ phase: 'error', message, files: attempt.files })
      toast.error('Upload failed', { description: message })
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null
      onBusyChange?.(false)
    }
  }

  async function startUpload(files: DroppedFile[]) {
    if (!space || !slug) {
      toast.error('Pick a space and a slug first.')
      return
    }
    if (files.length === 0 || preparingRef.current || uploadAbortRef.current) return
    preparingRef.current = true
    const target = { ...currentTarget }
    onBusyChange?.(true)
    setUpload({ phase: 'preparing', files, target })
    setStaged(null)
    try {
      const latest = await probeTarget(target)
      if (!latest) return
      if (latest.exists && !latest.owned) {
        setUpload({ phase: 'idle' })
        setStaged(files)
        toast.error('That URL is taken by someone else. Pick a different slug.')
        return
      }
      if (latest.exists) {
        setUpload({ phase: 'idle' })
        setPendingReplace({ files, target })
        return
      }
      await doUpload({ files, target, replace: false })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not check URL availability'
      setUpload({ phase: 'error', message, files })
    } finally {
      preparingRef.current = false
      onBusyChange?.(false)
    }
  }

  // Dropped/picked files. With a slug already set, deploy straight away ("drop, get a
  // URL"). Otherwise guess a slug from the folder/file name, pre-fill it, and stage the
  // files so the user can edit the slug before hitting Deploy.
  function handleIncoming(files: DroppedFile[]) {
    if (files.length === 0 || locked) return
    if (slug) {
      void startUpload(files)
      return
    }
    const derived = deriveSlug(files)
    if (derived) {
      setSlug(derived)
      checkSlug({ ...currentTarget, slug: derived })
    }
    setStaged(files)
  }

  const content = (
    <>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
        <div className="space-y-1.5">
          <Label htmlFor="deploy-space">Space</Label>
          <SpaceSelect
            id="deploy-space"
            value={space}
            onChange={(v) => {
              setSpace(v)
              invalidateConflict()
            }}
            spaces={spaces}
            disabled={locked}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="deploy-slug">Slug</Label>
          <Input
            id="deploy-slug"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value.toLowerCase())
              invalidateConflict()
            }}
            onBlur={() => checkSlug()}
            placeholder="my-runbook"
            className="font-mono"
            disabled={locked}
          />
        </div>

        <div className="space-y-1.5">
          <Label>Visibility</Label>
          <div>
            <VisibilityMenu value={visibility} onChange={setVisibility} disabled={locked} />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
        <span className="font-mono text-muted-foreground break-all">
          {origin}/{space || '—'}/{slug || '…'}
        </span>
        <SlugStatus
          slug={slug}
          checking={checking}
          available={available}
          takenByOther={takenByOther}
          ownedConflict={ownedConflict}
          error={checkError}
        />
      </div>

      <Dropzone
        dragActive={dragActive}
        available={available}
        takenByOther={takenByOther}
        ownedConflict={ownedConflict}
        busy={locked}
        onDragActive={setDragActive}
        onChooseFolder={() => folderInput.current?.click()}
        onChooseFiles={() => fileInput.current?.click()}
        onDropFiles={async (dt) => {
          setDragActive(false)
          handleIncoming(await filesFromDataTransfer(dt))
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        // @ts-expect-error non-standard attribute required for folder selection
        webkitdirectory=""
        hidden
        disabled={locked}
        onChange={(e) => {
          if (e.target.files) handleIncoming(filesFromInput(e.target.files))
          e.target.value = '' // allow re-selecting the same folder
        }}
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        disabled={locked}
        onChange={(e) => {
          if (e.target.files) handleIncoming(filesFromInput(e.target.files))
          e.target.value = '' // allow re-selecting the same file
        }}
      />

      {staged && !busy && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 px-4 py-3">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {staged.length} {staged.length === 1 ? 'file' : 'files'}
            </span>{' '}
            ready — edit the slug above, then deploy.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setStaged(null)}>
              Clear
            </Button>
            <Button
              size="sm"
              onClick={() => void startUpload(staged)}
              disabled={!slug || !space || takenByOther || checking}
            >
              <UploadCloud />
              Deploy
            </Button>
          </div>
        </div>
      )}

      {upload.phase === 'uploading' && (
        <div className="space-y-2">
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-200"
              style={{ width: `${upload.pct}%` }}
            />
          </div>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-3.5" />
            {upload.pct}% · {upload.count} files
          </p>
        </div>
      )}

      {upload.phase === 'preparing' && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Spinner className="size-3.5" />
          Checking destination…
        </p>
      )}

      {upload.phase === 'error' && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3"
        >
          <div>
            <p className="font-medium text-destructive text-sm">Upload failed</p>
            <p className="text-muted-foreground text-xs">{upload.message}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void startUpload(upload.files)} disabled={locked}>
            Retry {upload.files.length === 1 ? 'file' : `${upload.files.length} files`}
          </Button>
        </div>
      )}

      {upload.phase === 'done' && (
        <Card className="gap-3 border-success/40 bg-success/5 py-4">
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-success">Deployed</p>
              <p className="truncate font-mono text-sm text-muted-foreground">{upload.url}</p>
            </div>
            <div className="flex items-center gap-2">
              <CopyButton text={upload.url} />
              <Button asChild size="sm">
                <a href={upload.url} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  Open
                </a>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  )

  // Controlled replace confirmation — state holds the pending files. Rendered alongside both layouts.
  const replaceDialog = (
    <AlertDialog
      open={pendingReplace !== null}
      onOpenChange={(o) => {
        if (!o) setPendingReplace(null)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Replace{' '}
            <span className="font-mono">
              {pendingReplace?.target.space}/{pendingReplace?.target.slug}
            </span>
            ?
          </AlertDialogTitle>
          <AlertDialogDescription>This overwrites all files.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={() => {
              const pending = pendingReplace
              setPendingReplace(null)
              if (pending) void doUpload({ ...pending, replace: true })
            }}
          >
            Replace
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return (
    <>
      <div className="space-y-5">{content}</div>
      {replaceDialog}
    </>
  )
}

function SlugStatus({
  slug,
  checking,
  available,
  takenByOther,
  ownedConflict,
  error,
}: {
  slug: string
  checking: boolean
  available: boolean
  takenByOther: boolean
  ownedConflict: boolean
  error: boolean
}) {
  if (!slug) return null
  if (checking)
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Spinner className="size-3.5" />
        checking…
      </span>
    )
  if (takenByOther) return <span className="font-medium text-destructive">taken by someone else</span>
  if (ownedConflict)
    return <span className="font-medium text-primary">you already own this — uploading replaces it</span>
  if (available) return <span className="font-medium text-success">available</span>
  if (error) return <span className="font-medium text-destructive">could not check availability</span>
  return null
}

function Dropzone({
  dragActive,
  available,
  takenByOther,
  ownedConflict,
  busy,
  onDragActive,
  onChooseFolder,
  onChooseFiles,
  onDropFiles,
}: {
  dragActive: boolean
  available: boolean
  takenByOther: boolean
  ownedConflict: boolean
  busy: boolean
  onDragActive: (v: boolean) => void
  onChooseFolder: () => void
  onChooseFiles: () => void
  onDropFiles: (dt: DataTransfer) => void
}) {
  const tint = takenByOther
    ? 'border-destructive/50 bg-destructive/5'
    : ownedConflict
      ? 'border-primary/50 bg-primary/5'
      : available
        ? 'border-success/50 bg-success/5'
        : 'border-border bg-muted/30'

  // A full-zone overlay <button> is the click target → file picker (the common single/multi-file
  // case); the labels above set pointer-events-none so a click anywhere in the zone falls through
  // to it. Folders go via drag-drop, or the separate "upload a folder" button. One native dialog
  // can't offer files AND folders at once, and a real button can't nest another — hence two
  // sibling buttons rather than one role="button" wrapper.
  return (
    <div
      className={cn(
        'relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors',
        dragActive ? 'border-primary bg-primary/10' : tint,
        busy && 'pointer-events-none opacity-60',
      )}
      onDragOver={(e) => {
        e.preventDefault()
        onDragActive(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        onDragActive(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDropFiles(e.dataTransfer)
      }}
    >
      <button
        type="button"
        aria-label="Choose files to upload"
        className="absolute inset-0 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onChooseFiles}
        disabled={busy}
      />
      <div className="pointer-events-none relative flex size-12 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm">
        <FolderUp className="size-6" />
      </div>
      <div className="pointer-events-none relative">
        <p className="font-medium">Drop files or a folder here</p>
        <p className="text-sm text-muted-foreground">
          click to choose files, or{' '}
          <button
            type="button"
            className="pointer-events-auto font-medium text-primary underline-offset-2 hover:underline"
            onClick={onChooseFolder}
            disabled={busy}
          >
            upload a folder
          </button>
        </p>
      </div>
    </div>
  )
}
