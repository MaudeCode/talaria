import { appUrl } from '../lib/appRoot'

/** The Hermes brandmark (static/brand/brandmark.svg) as an inline mask so it inherits `currentColor`. */
export function Brandmark({ className, size }: { className?: string; size?: number }) {
  const url = appUrl('static/brand/brandmark.svg').href
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
  return <span className={className} style={style} aria-hidden="true" />
}
