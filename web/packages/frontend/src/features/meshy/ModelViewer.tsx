import { useEffect, useRef, useState } from 'react'
import type { MeshyAsset } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import { appUrl } from '../../lib/appRoot'
import { prefersReducedMotion } from '../../lib/motion'
import { Button } from '../../ui/Button'

type ViewerElement = HTMLElement & { availableAnimations?: string[]; animationName?: string | null; play: (options?: { repetitions?: number }) => void; pause: () => void }

let loader: Promise<unknown> | null = null
/** The renderer loads once, the first time a model is shown; a failed load can be retried. */
function loadRenderer(): Promise<unknown> {
  loader ??= import('@google/model-viewer').catch((error: unknown) => { loader = null; throw error })
  return loader
}

/**
 * TAL-1514: the one 3D renderer for inline previews and the gallery. Orbit and zoom by pointer or arrow keys once focused;
 * animations never start on their own under reduced motion. Unmounting releases the element and its WebGL context.
 */
export function ModelViewer({ asset, title, autoRotate = false }: { asset: MeshyAsset; title: string; autoRotate?: boolean }) {
  const viewer = useRef<ViewerElement | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [rendererReady, setRendererReady] = useState(false)
  const [clips, setClips] = useState<string[]>([])
  const [clip, setClip] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const reduced = prefersReducedMotion()

  useEffect(() => {
    let live = true
    loadRenderer().then(() => { if (live) setRendererReady(true) }, () => { if (live) setPhase('error') })
    return () => { live = false }
  }, [attempt])

  useEffect(() => {
    const el = viewer.current
    if (!el || !rendererReady) return
    const onLoad = () => {
      const names = [...(el.availableAnimations ?? [])]
      setClips(names)
      setClip(names[0] ?? null)
      setPhase('ready')
      if (names.length > 0 && !reduced) { el.play({ repetitions: Infinity }); setPlaying(true) }
    }
    const onError = () => { setPhase('error') }
    el.addEventListener('load', onLoad)
    el.addEventListener('error', onError)
    return () => { el.removeEventListener('load', onLoad); el.removeEventListener('error', onError) }
  }, [rendererReady, attempt, reduced])

  const toggle = () => {
    const el = viewer.current
    if (!el) return
    if (playing) el.pause()
    else el.play({ repetitions: Infinity })
    setPlaying(!playing)
  }
  const choose = (name: string) => {
    const el = viewer.current
    setClip(name)
    if (!el) return
    el.animationName = name
    if (playing) el.play({ repetitions: Infinity })
  }
  const retry = () => { setPhase('loading'); setClips([]); setPlaying(false); setAttempt((n) => n + 1) }

  return (
    <div className="flex w-full max-w-xl flex-col gap-1.5">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-md bg-surface">
        {rendererReady && phase !== 'error' && (
          <model-viewer
            key={attempt}
            ref={viewer}
            src={appUrl(asset.url.replace(/^\.\//, '')).href}
            alt={title}
            aria-label={m.meshy_viewer_label({ title })}
            camera-controls=""
            interaction-prompt="none"
            touch-action="pan-y"
            shadow-intensity="0.6"
            tabIndex={0}
            {...(autoRotate && !reduced ? { 'auto-rotate': '' } : {})}
            style={{ width: '100%', height: '100%', outlineOffset: '-2px' }}
          />
        )}
        {phase === 'loading' && <div role="status" className="pointer-events-none absolute inset-0 grid place-items-center text-[12px] text-muted">{m.meshy_model_loading()}</div>}
        {phase === 'error' && (
          <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center text-[12px] text-muted">
            {m.meshy_model_error()}
            <Button onClick={retry}>{m.retry()}</Button>
          </div>
        )}
      </div>
      {phase === 'ready' && clips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <Button onClick={toggle} aria-pressed={playing}>{playing ? m.meshy_animation_pause() : m.meshy_animation_play()}</Button>
          {clips.length > 1 && (
            <select aria-label={m.meshy_animation_clip()} value={clip ?? ''} onChange={(event) => { choose(event.target.value) }} className="min-h-8 rounded-md border border-border bg-bg px-2 text-text">
              {clips.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          )}
        </div>
      )}
    </div>
  )
}
