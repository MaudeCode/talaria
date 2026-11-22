/** The part of noVNC's RFB client the screen viewer uses (the package ships no types). */
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string, options?: { shared?: boolean })
    viewOnly: boolean
    scaleViewport: boolean
    resizeSession: boolean
    background: string
    disconnect(): void
  }
}
