import { Building2, ChevronDown, Globe, Lock, type LucideIcon, Users } from 'lucide-react'
import type { Visibility } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// Ordered least-restrictive first so the menu reads as a ramp; `unlisted` is the only tier
// that admits an anonymous reader, so it is labelled by its risk, not by its convenience.
const VISIBILITIES: Visibility[] = ['unlisted', 'private', 'members', 'team']

export const VISIBILITY_META: Record<Visibility, { label: string; hint: string; icon: LucideIcon; badge: string }> = {
  unlisted: {
    label: 'Unlisted',
    hint: 'Anyone with the link, no login',
    icon: Globe,
    badge: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  },
  private: {
    label: 'Restricted',
    hint: 'Only you and people you share with',
    icon: Lock,
    badge: 'bg-muted text-muted-foreground',
  },
  members: {
    label: 'Space members',
    hint: 'People added to this space',
    icon: Users,
    badge: 'bg-sky-500/15 text-sky-600 dark:text-sky-300',
  },
  team: {
    label: 'All users',
    hint: 'Everyone signed in to Postplan',
    icon: Building2,
    badge: 'bg-primary/15 text-primary',
  },
}

export function VisibilityBadge({
  value,
  className,
  compactOnMobile = false,
}: {
  value: Visibility
  className?: string
  compactOnMobile?: boolean
}) {
  const m = VISIBILITY_META[value]
  const Icon = m.icon
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', m.badge, className)}
    >
      <Icon className="size-3" />
      <span className={cn(compactOnMobile && 'sr-only sm:not-sr-only')}>{m.label}</span>
    </span>
  )
}

export function VisibilityMenu({
  value,
  onChange,
  disabled,
  trigger = 'button',
  compactOnMobile = false,
}: {
  value: Visibility
  onChange: (v: Visibility) => void
  disabled?: boolean
  // 'chip' renders the status badge itself as the trigger (for dense table rows); 'button' is
  // the standalone form-control look used on the deploy card.
  trigger?: 'button' | 'chip'
  compactOnMobile?: boolean
}) {
  const m = VISIBILITY_META[value]
  const Icon = m.icon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger === 'chip' ? (
          <button
            type="button"
            disabled={disabled}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-opacity hover:opacity-80 disabled:opacity-50',
              m.badge,
            )}
          >
            <Icon className="size-3" />
            <span className={cn(compactOnMobile && 'sr-only sm:not-sr-only')}>{m.label}</span>
            <ChevronDown className="size-3 opacity-60" />
          </button>
        ) : (
          <Button variant="outline" size="sm" disabled={disabled} className="gap-1.5">
            <Icon className="size-3.5" />
            {m.label}
            <ChevronDown className="size-3.5 opacity-60" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Who can see this</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as Visibility)}>
          {VISIBILITIES.map((v) => {
            const meta = VISIBILITY_META[v]
            const I = meta.icon
            return (
              <DropdownMenuRadioItem key={v} value={v} className="items-start gap-2 py-2">
                <I className="mt-0.5 size-3.5 shrink-0" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium leading-none">{meta.label}</span>
                  <span className="text-muted-foreground text-xs leading-snug">{meta.hint}</span>
                </span>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
