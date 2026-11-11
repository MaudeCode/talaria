import { Component, createRef, type ReactNode } from 'react'
import { flipList, measureList, motionOn, revealHeight, type ListSnapshot } from '../lib/motion'

interface Props<T> {
  items: T[]
  itemKey: (item: T) => string
  scope: string
  context: object
  ready: boolean
  id: string
  className: string
  children: (items: T[], previous: T[], animate: boolean) => ReactNode
}
interface State<T> {
  input: T[]; items: T[]; previous: T[]; exiting: Set<string>
  scope: string; context: object; ready: boolean; animate: boolean
}

/** RowList owns plain list markup; this wrapper owns presence and the pre-mutation snapshot grouped lists need. */
export class MotionList<T> extends Component<Props<T>, State<T>, ListSnapshot | null> {
  private container = createRef<HTMLDivElement>()
  private animations = new Set<Animation>()
  private closing = new Map<string, Animation>()
  private moves: Animation[] = []
  override state: State<T> = { input: this.props.items, items: this.props.items, previous: [], exiting: new Set(), scope: this.props.scope, context: this.props.context, ready: this.props.ready, animate: false }

  static getDerivedStateFromProps<T>(props: Props<T>, state: State<T>): Partial<State<T>> | null {
    if (props.items === state.input && props.scope === state.scope && props.context === state.context && props.ready === state.ready) return null
    const animate = props.ready && state.ready && props.scope === state.scope && props.context === state.context && motionOn()
    const items = [...props.items], keys = new Set(items.map(props.itemKey)), exiting = new Set<string>()
    if (animate) state.items.forEach((item, index) => {
      const key = props.itemKey(item)
      if (!keys.has(key)) { items.splice(Math.min(index, items.length), 0, item); exiting.add(key) }
    })
    return { input: props.items, items, previous: animate ? state.input : [], exiting, scope: props.scope, context: props.context, ready: props.ready, animate }
  }

  override getSnapshotBeforeUpdate(): ListSnapshot | null {
    return this.state.animate && motionOn() && this.container.current ? measureList(this.container.current) : null
  }

  private track(animation: Animation) {
    this.animations.add(animation)
    const forget = () => this.animations.delete(animation)
    void animation.finished.then(forget, forget)
  }

  override componentDidUpdate(_props: Props<T>, _state: State<T>, before: ListSnapshot | null) {
    const container = this.container.current
    if (!container) return
    for (const el of container.querySelectorAll<HTMLElement>('[data-motion-key]')) {
      const exiting = this.state.exiting.has(el.getAttribute('data-motion-key') ?? '')
      el.toggleAttribute('inert', exiting)
      if (exiting) el.setAttribute('aria-hidden', 'true'); else el.removeAttribute('aria-hidden')
    }
    if (!before || !motionOn()) { this.cancel(); return }
    for (const animation of this.moves) animation.cancel()
    const current = measureList(container)
    const previousKeys = new Set(this.state.previous.map(this.props.itemKey))
    const retire = (key: string) => this.setState((state) => {
      if (!state.exiting.has(key)) return null
      const exiting = new Set(state.exiting); exiting.delete(key)
      return { items: state.items.filter((item) => this.props.itemKey(item) !== key), exiting }
    })
    for (const [key, { el }] of current) {
      const exiting = this.state.exiting.has(key)
      if (exiting && !this.closing.has(key)) {
        const animation = revealHeight(el, { open: false })
        if (!animation) { retire(key); continue }
        this.closing.set(key, animation); this.track(animation)
        void animation.finished.then(() => {
          if (this.closing.get(key) === animation) { this.closing.delete(key); retire(key) }
        }, () => undefined)
      } else if (!exiting && (this.closing.has(key) || (!previousKeys.has(key) && !before.has(key)))) {
        this.closing.delete(key)
        const animation = revealHeight(el, { open: true, arrive: true })
        if (animation) this.track(animation)
      }
    }
    // An offscreen or collapsed exit has no motion to wait for.
    for (const key of this.state.exiting) if (!current.has(key)) retire(key)
    this.moves = flipList(container, before)
    for (const animation of this.moves) this.track(animation)
  }

  private cancel() {
    for (const animation of this.animations) animation.cancel()
    this.animations.clear(); this.closing.clear(); this.moves = []
  }
  override componentWillUnmount() { this.cancel() }
  override render() {
    return <div ref={this.container} id={this.props.id} className={this.props.className} role="list">{this.props.children(this.state.items, this.state.previous, this.state.animate)}</div>
  }
}
