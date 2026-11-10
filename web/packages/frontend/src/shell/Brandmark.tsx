import { appUrl } from '../lib/appRoot'

/**
 * The Hermes brandmark (static/brand/brandmark.svg), or another single-colour brand file under `static/brand/` (`src`),
 * as an inline mask so it inherits `currentColor`.
 */
export function Brandmark({ className, size, src = 'static/brand/brandmark.svg', ...data }: { className?: string; size?: number; src?: string } & Record<`data-${string}`, string>) {
  const url = appUrl(src).href
  const style: React.CSSProperties = {
    display: 'inline-block',
    ...(size ? { width: size, height: size } : {}),
    backgroundColor: 'currentColor',
    WebkitMaskImage: `url("${url}")`,
    maskImage: `url("${url}")`,
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskSize: 'contain',
    maskSize: 'contain',
    WebkitMaskPosition: 'center',
    maskPosition: 'center',
  }
  return <span {...data} className={className} style={style} aria-hidden="true" />
}
