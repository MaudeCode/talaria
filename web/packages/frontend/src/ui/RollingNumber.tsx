import { SwapText } from './SwapText'

/** SwapText owns interruption and cleanup; number places roll instead of cross-fading a whole label. */
export function RollingNumber({ value, text = String(value), animate = true }: { value: number; text?: string; animate?: boolean }) {
  const parts = text.match(/\d|[^\d]+/gu) ?? []
  return <span className="relative tabular-nums" data-rolling-number={value}>
    <span className="sr-only">{text}</span>
    <span aria-hidden="true" className="whitespace-pre">{parts.map((part, index) => /\d/.test(part)
      ? <SwapText key={parts.length - index} text={part} animate={animate} roll />
      : <span key={parts.length - index}>{part}</span>)}</span>
  </span>
}
