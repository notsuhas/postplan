import { Pause, Play, Repeat, StepBack, StepForward } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import { MOTION_RATES } from '../../../../shared/motion'
import { Button } from '@/components/ui/button'
import { formatTimestamp } from '@/lib/timestamp'
import { deriveMotionKey, type MotionStore } from '@/lib/motion'
import { cn } from '@/lib/utils'

interface IMotionBar {
  store: MotionStore
}

export function MotionBar(props: IMotionBar) {
  const { store } = props
  const state = useSyncExternalStore(store.subscribe, store.get)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const s = store.get()
      const action = s && deriveMotionKey(e)
      if (!action) return
      e.preventDefault()
      if (action === 'toggle') store.command({ cmd: s.playing ? 'pause' : 'play' })
      else store.command({ cmd: 'step', dir: action === 'back' ? -1 : 1 })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store])

  if (!state) return null
  const { duration, t, playing, rate, loop } = state

  return (
    <fieldset className="flex flex-wrap items-center justify-center gap-2 border-t p-2" aria-label="Motion">
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        aria-label="Previous frame"
        onClick={() => store.command({ cmd: 'step', dir: -1 })}
      >
        <StepBack />
      </Button>
      <button
        type="button"
        onClick={() => store.command({ cmd: playing ? 'pause' : 'play' })}
        aria-label={playing ? 'Pause' : 'Play'}
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm outline-none transition-colors hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {playing ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 fill-current" />}
      </button>
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        aria-label="Next frame"
        onClick={() => store.command({ cmd: 'step', dir: 1 })}
      >
        <StepForward />
      </Button>
      <input
        type="range"
        min={0}
        max={duration}
        step={0.01}
        value={t}
        onChange={(e) => store.command({ cmd: 'seek', t: Number(e.target.value) })}
        aria-label="Seek"
        aria-valuetext={`${formatTimestamp(t)} of ${formatTimestamp(duration)}`}
        className="h-1 min-w-24 flex-1 cursor-pointer accent-primary"
      />
      <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
        {formatTimestamp(t)} / {formatTimestamp(duration)}
      </span>
      <fieldset className="flex gap-2" aria-label="Playback speed">
        {MOTION_RATES.map((r) => (
          <Button
            key={r}
            variant="outline"
            size="sm"
            aria-pressed={rate === r}
            className={cn('font-mono tabular-nums', rate === r && 'bg-accent text-accent-foreground')}
            onClick={() => store.command({ cmd: 'rate', rate: r })}
          >
            {r}x
          </Button>
        ))}
      </fieldset>
      <Button
        variant="outline"
        size="icon"
        aria-label="Loop"
        aria-pressed={loop}
        className={cn('size-8', loop && 'bg-accent text-accent-foreground')}
        onClick={() => store.command({ cmd: 'loop', on: !loop })}
      >
        <Repeat />
      </Button>
    </fieldset>
  )
}
