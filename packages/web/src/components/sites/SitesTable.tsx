import { useCallback, useState } from 'react'
import { useRevalidator } from 'react-router'
import {
  Copy,
  FolderInput,
  GitFork,
  History,
  MoreVertical,
  Pencil,
  RotateCcw,
  Share2,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ForkDialog } from '@/components/sites/ForkDialog'
import { ShareDialog } from '@/components/sites/ShareDialog'
import { SummarySheet } from '@/components/sites/SummarySheet'
import {
  actionsColumn,
  createdColumn,
  nameColumn,
  starColumn,
  OpenLinkButton,
  urlColumn,
  visibilityColumn,
} from '@/components/sites/siteColumns'
import { SortableTable, type Column } from '@/components/ui/SortableTable'
import { SpaceSelect } from '@/components/spaces/SpaceSelect'
import { Spinner } from '@/components/ui/states'
import { VisibilityMenu } from '@/components/sites/visibility'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MountSensor } from '@/components/ui/mount-sensor'
import { api } from '@/lib/api'
import type { SiteSummary, SpaceSummary, Visibility } from '@/lib/types'
import { type ISiteVersion, versionDiff } from '@/lib/siteVersions'

const visibilityLabel = (v: Visibility): string => v.charAt(0).toUpperCase() + v.slice(1)

// Stable module-scope columns so SortableTable's sort memo doesn't rebuild every render.
const OWNER_COLUMNS: Column<SiteSummary>[] = [
  starColumn(),
  nameColumn(),
  urlColumn(),
  visibilityColumn((s) => <OwnerVisibilityCell site={s} />),
  createdColumn(),
  actionsColumn((s) => <OwnerActions site={s} />),
]

export function SitesTable({ sites }: { sites: SiteSummary[] }) {
  return (
    <SortableTable
      rows={sites}
      columns={OWNER_COLUMNS}
      getRowKey={(s) => s.id}
      initialSort={{ key: 'created', dir: 'desc' }}
    />
  )
}

// Owner-only visibility control: an optimistic chip that opens the tier picker.
function OwnerVisibilityCell({ site }: { site: SiteSummary }) {
  const revalidator = useRevalidator()
  const [pendingVis, setPendingVis] = useState<Visibility | null>(null)
  // Hold the optimistic tier until the revalidated loader reflects it. Clearing on PATCH success
  // (before revalidate lands) flickered the chip back to the OLD tier for the whole round-trip
  // (#37). Reconcile during render — React's derive-from-props pattern — rather than an effect:
  // once the fresh `site.visibility` catches up to the pending value, drop the override.
  if (pendingVis !== null && site.visibility === pendingVis) setPendingVis(null)
  const visibility = pendingVis ?? site.visibility

  async function changeVisibility(v: Visibility) {
    setPendingVis(v)
    try {
      await api.patch(`/api/sites/${site.spaceSlug}/${site.siteSlug}`, { visibility: v })
      toast.success('Visibility updated', { description: visibilityLabel(v) })
      revalidator.revalidate() // pendingVis stays until the revalidated data matches (see above)
    } catch (err) {
      setPendingVis(null)
      toast.error('Could not update visibility', {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  return <VisibilityMenu trigger="chip" value={visibility} onChange={changeVisibility} />
}

type RowDialog = 'rename' | 'move' | 'share' | 'summary' | 'fork' | 'history' | 'delete' | null

// Open + a kebab that collapses Rename / Move / Share / Copy link / Fork / Delete.
function OwnerActions({ site }: { site: SiteSummary }) {
  const revalidator = useRevalidator()
  const [dialog, setDialog] = useState<RowDialog>(null)
  const refresh = () => revalidator.revalidate()
  const close = () => setDialog(null)

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(site.url)
      toast.success('Link copied')
    } catch {
      toast.error("Couldn't copy to clipboard")
    }
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <OpenLinkButton url={site.url} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="More actions">
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={() => setDialog('rename')}>
            <Pencil />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('move')}>
            <FolderInput />
            Move
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('share')}>
            <Share2 />
            Share…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('summary')}>
            <Sparkles />
            {site.hasSummary ? 'Summary' : 'Summarize'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void copyLink()}>
            <Copy />
            Copy link
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('fork')}>
            <GitFork />
            Fork
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('history')}>
            <History />
            Version history
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDialog('delete')}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Controlled dialogs driven by the kebab (a Dialog trigger can't live inside a menu item
          cleanly). Each renders only a portaled body — nothing inline in the cell. */}
      <RenameDialog site={site} open={dialog === 'rename'} onOpenChange={(o) => !o && close()} onDone={refresh} />
      <MoveDialog site={site} open={dialog === 'move'} onOpenChange={(o) => !o && close()} onDone={refresh} />
      <ShareDialog
        spaceSlug={site.spaceSlug}
        siteSlug={site.siteSlug}
        title={site.title}
        open={dialog === 'share'}
        onOpenChange={(o) => !o && close()}
      />
      <ForkDialog site={site} open={dialog === 'fork'} onOpenChange={(o) => !o && close()} />
      <VersionHistoryDialog
        site={site}
        open={dialog === 'history'}
        onOpenChange={(o) => !o && close()}
        onDone={refresh}
      />
      <SummarySheet
        spaceSlug={site.spaceSlug}
        siteSlug={site.siteSlug}
        open={dialog === 'summary'}
        onOpenChange={(o) => !o && close()}
        onGenerated={refresh}
      />
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(o) => !o && close()}
        title={`Delete ${site.spaceSlug}/${site.siteSlug}?`}
        description="This permanently removes the site and all its files."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await api.delete(`/api/sites/${site.spaceSlug}/${site.siteSlug}`)
          toast.success('Site deleted')
          refresh()
        }}
      />
    </div>
  )
}

interface IVersionHistoryDialog {
  site: SiteSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}

function VersionHistoryDialog(props: IVersionHistoryDialog) {
  const { site, open, onOpenChange, onDone } = props
  const [versions, setVersions] = useState<ISiteVersion[]>([])
  const [busy, setBusy] = useState(false)
  const [restoring, setRestoring] = useState<number | null>(null)

  const load = useCallback(() => {
    setBusy(true)
    api
      .get<ISiteVersion[]>(`/api/sites/${site.spaceSlug}/${site.siteSlug}/versions`)
      .then(setVersions)
      .catch((err) =>
        toast.error('Could not load versions', { description: err instanceof Error ? err.message : undefined }),
      )
      .finally(() => setBusy(false))
  }, [site.spaceSlug, site.siteSlug])

  const current = versions.find((version) => version.current)

  async function rollback(version: number) {
    if (!current) return
    setRestoring(version)
    try {
      await api.post(`/api/sites/${site.spaceSlug}/${site.siteSlug}/versions/${version}/rollback`, {
        expectedVersion: current.version,
      })
      toast.success(`Restored version ${version}`)
      load()
      onDone()
    } catch (err) {
      toast.error('Could not restore version', { description: err instanceof Error ? err.message : undefined })
    } finally {
      setRestoring(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(value) => !restoring && onOpenChange(value)}>
      <DialogContent className="sm:max-w-xl">
        <MountSensor onMount={load} />
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Compare deployments and restore any earlier version as a new deployment.
          </DialogDescription>
        </DialogHeader>
        {busy && versions.length === 0 ? (
          <div className="flex justify-center py-10">
            <Spinner className="size-5" />
          </div>
        ) : (
          <div className="max-h-[26rem] space-y-2 overflow-y-auto pr-1">
            {versions.map((version) => {
              const diff = current && !version.current ? versionDiff(version.files, current.files) : null
              const summary = diff
                ? `${diff.added.length} added · ${diff.changed.length} changed · ${diff.removed.length} removed`
                : `${version.files.length} files`
              return (
                <div key={version.version} className="flex items-center gap-3 rounded-lg border p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 font-mono text-sm">
                      <span>v{version.version}</span>
                      {version.current && (
                        <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">current</span>
                      )}
                      {version.restoredFrom !== null && (
                        <span className="text-xs text-muted-foreground">from v{version.restoredFrom}</span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {summary} · {new Date(version.createdAt).toLocaleString()}
                    </p>
                  </div>
                  {!version.current && current && (
                    <ConfirmDialog
                      title={`Restore version ${version.version}?`}
                      description={`This creates version ${current.version + 1}. Nothing in the history is deleted.`}
                      confirmLabel="Restore"
                      onConfirm={() => rollback(version.version)}
                    >
                      <Button variant="outline" size="sm" disabled={restoring !== null}>
                        <RotateCcw /> Restore
                      </Button>
                    </ConfirmDialog>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ─── Dialogs ──────────────────────────────────────────────────────────────────

function RenameDialog({
  site,
  open,
  onOpenChange,
  onDone,
}: {
  site: SiteSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [title, setTitle] = useState(site.title ?? '')
  const [saving, setSaving] = useState(false)

  // Reseed the field each time the dialog opens. The ref lives on a plain sensor <div> below (NOT
  // on DialogContent): Radix composes the content ref and RE-ATTACHES it on every render, so a
  // ref-callback there re-runs on every keystroke — snapping the input back to site.title and making
  // rename impossible (#1). A plain element's ref is uncomposed, so this fires once per open. (cf.
  // MoveDialog/ShareDialog.)
  const seed = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) setTitle(site.title ?? '')
    },
    [site.title],
  )

  async function save() {
    setSaving(true)
    try {
      await api.patch(`/api/sites/${site.spaceSlug}/${site.siteSlug}`, { title })
      toast.success('Renamed')
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.error('Could not rename', {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent>
        <div ref={seed} hidden aria-hidden="true" />
        <DialogHeader>
          <DialogTitle>Rename site</DialogTitle>
          <DialogDescription className="font-mono">{site.url}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={`rename-${site.id}`}>Title</Label>
          <Input
            id={`rename-${site.id}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={site.siteSlug}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void save()
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Spinner />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Move a site into another space the caller belongs to. Spaces load on open (via a content
// ref-callback — no effect); the current space is excluded. Moving keeps the site's
// files/comments/shares — only its URL changes — so a revalidate picks up the new URL.
function MoveDialog({
  site,
  open,
  onOpenChange,
  onDone,
}: {
  site: SiteSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [spaces, setSpaces] = useState<SpaceSummary[]>([])
  const [target, setTarget] = useState('')
  const [audienceChangeAccepted, setAudienceChangeAccepted] = useState(false)
  const changesAudience = site.visibility === 'members'

  const loadOnMount = useCallback(() => {
    setTarget('')
    setAudienceChangeAccepted(false)
    setBusy(true)
    api
      .get<SpaceSummary[]>('/api/spaces/mine')
      .then((sp) => setSpaces(sp.filter((s) => s.slug !== site.spaceSlug)))
      .catch((err) =>
        toast.error('Could not load spaces', { description: err instanceof Error ? err.message : undefined }),
      )
      .finally(() => setBusy(false))
  }, [site.spaceSlug])

  async function save() {
    if (!target || (changesAudience && !audienceChangeAccepted)) return
    setSaving(true)
    try {
      const { url } = await api.post<{ url: string }>(`/api/sites/${site.spaceSlug}/${site.siteSlug}/move`, {
        space: target,
        ...(changesAudience && { confirmAudienceChange: true }),
      })
      toast.success('Site moved', { description: url })
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.error('Could not move site', { description: err instanceof Error ? err.message : undefined })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent>
        <MountSensor onMount={loadOnMount} />
        <DialogHeader>
          <DialogTitle>Move site</DialogTitle>
          <DialogDescription className="font-mono">{site.url}</DialogDescription>
        </DialogHeader>
        {busy ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Spinner className="size-5" />
          </div>
        ) : spaces.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            You’re only in one space. Create another space to move sites into it.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor={`move-${site.id}`}>Destination space</Label>
              <SpaceSelect id={`move-${site.id}`} value={target} onChange={setTarget} spaces={spaces} />
            </div>
            {changesAudience && (
              <label className="flex gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                  checked={audienceChangeAccepted}
                  onChange={(event) => setAudienceChangeAccepted(event.target.checked)}
                />
                <span>
                  <span className="block font-medium">This changes who can view the site</span>
                  <span className="mt-1 block text-muted-foreground">
                    Members of {site.spaceSlug} may lose access, while members of the destination gain access. Direct
                    shares stay in place.
                  </span>
                  <span className="mt-2 block">I understand the audience will change.</span>
                </span>
              </label>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || saving || !target || (changesAudience && !audienceChangeAccepted)}>
            {saving && <Spinner />}
            {changesAudience ? 'Move and change audience' : 'Move'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
