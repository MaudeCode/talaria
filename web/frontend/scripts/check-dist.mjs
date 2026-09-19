// CI gate: the committed static/dist must equal a clean rebuild.
// Usage: npm run build && node scripts/check-dist.mjs
// Compares the git-tracked tree with the working tree after the build.
import { execFileSync } from 'node:child_process'

const out = execFileSync('git', ['status', '--porcelain', '--', 'static/dist'], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' })
if (out.trim()) {
  console.error('check-dist: committed static/dist differs from a clean build:\n' + out)
  console.error('Run `npm --prefix frontend run build` and commit static/dist.')
  process.exit(1)
}
console.log('check-dist: static/dist is current')
