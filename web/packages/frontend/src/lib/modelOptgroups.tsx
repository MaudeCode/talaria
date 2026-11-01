import type { Models } from '@maudecode/talaria-web-contracts'
import { catalogGroupLabel, catalogModelSections, ModelOptionContent } from './modelEntry'
// Its own module: only lazily loaded pickers (cron job form, project defaults) use it, so it stays out of the layout bundle.
/** The catalog as `<Select>` option groups; a plain list, since `Select` reads `<optgroup>`/`<option>` children directly. */
export function catalogModelOptgroups(catalog: Models | undefined) {
  return (catalog?.groups ?? []).flatMap((g) => catalogModelSections(g).map((section) => (
    <optgroup key={`${g.provider}:${section.label}`} label={[catalogGroupLabel(g), section.label].filter(Boolean).join(' · ')}>
      {section.models.map((entry) => <option key={entry.id} value={entry.id}><ModelOptionContent entry={entry} /></option>)}
    </optgroup>
  )))
}
