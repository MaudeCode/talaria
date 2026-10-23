import { createElement, memo, type ComponentType, type MemoExoticComponent } from 'react'

/** Count render bodies while retaining the production component's memo boundary. */
export function countRenders<P extends object>(component: ComponentType<P>, count: (props: P) => void): ComponentType<P> {
  const original = component as MemoExoticComponent<ComponentType<P>>
  const body = original.type ?? component
  const counted = (props: P) => { count(props); return createElement(body, props) }
  return original.type ? memo(counted) : counted
}
