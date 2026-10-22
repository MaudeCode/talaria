import type { ComponentProps } from 'react'
import { Switch } from '../../ui/Field'
import type { ResourceEffect } from './useResourceMutation'

/** The existing switch showing the user's requested value at once; it stays usable while the write settles. */
export function ResourceSwitch({ effect, checked, stateLabel, ...props }: ComponentProps<typeof Switch> & { effect: ResourceEffect<boolean> | undefined; stateLabel?: (checked: boolean) => string }) {
  const requested = effect?.value ?? checked
  const control = <Switch {...props} checked={requested} />
  return stateLabel ? <label className="inline-flex min-h-11 cursor-pointer items-center gap-1 text-xs text-muted">
    {control}
    <span aria-hidden="true">{stateLabel(!!requested)}</span>
  </label> : control
}
