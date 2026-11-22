import { Camera, Paperclip } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react'
import { m } from '../../paraglide/messages'
import { useMediaQuery } from '../../shell/useShellState'
import { MenuItem } from '../../ui/Menu'
import { ComposerMenu } from './chips'

/** TAL-1124: a touch-first phone or tablet picks between the camera and its files; a mouse opens the file picker directly. */
export const TOUCH_QUERY = '(pointer: coarse)'

/**
 * The composer's attach control. Both pickers hand their files to `onFiles`, the composer's one attach path. `owner` names
 * whose draft the files join (chat, profile, clarification); a new owner closes the menu. `fallbackFocus` takes focus when
 * the open menu goes away with the control.
 */
export function AttachControl({ owner, onFiles, fallbackFocus }: { owner: string; onFiles: (files: FileList) => void; fallbackFocus: RefObject<HTMLElement | null> }) {
  const touch = useMediaQuery(TOUCH_QUERY)
  const files = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  // Open for the owner it opened under, so another owner, or a mouse taking over, finds it closed.
  const [openFor, setOpenFor] = useState<string | null>(null)
  if (!touch && openFor !== null) setOpenFor(null)
  const open = openFor === owner
  const wasOpen = useRef(false)
  useLayoutEffect(() => { wasOpen.current = open })
  // A menu removed while open (the control hidden, a mouse taking over) takes focus with it; the composer gets it back.
  useLayoutEffect(() => {
    if (!touch) return
    return () => {
      if (wasOpen.current) queueMicrotask(() => { if (document.activeElement === document.body) fallbackFocus.current?.focus() })
    }
  }, [touch, fallbackFocus])
  const pick = (e: ChangeEvent<HTMLInputElement>) => { if (e.target.files?.length) onFiles(e.target.files); e.target.value = '' }
  const label = m.composer_control_attach()
  // The tooltip hides while the menu is open; the button keeps its name.
  const button = <button type="button" className="icon-btn has-tooltip data-[popup-open]:after:hidden" id="btnAttach" data-tooltip={label} aria-label={label} {...(touch ? {} : { onClick: () => files.current?.click() })}><Paperclip size={16} aria-hidden="true" /></button>
  return (
    <>
      <input ref={files} type="file" id="fileInput" multiple className="file-input-visually-hidden" onChange={pick} accept="image/*,text/*,application/pdf,application/json,.csv,.md" />
      {touch && <input ref={camera} type="file" id="cameraInput" className="file-input-visually-hidden" onChange={pick} accept="image/*" capture="environment" />}
      {touch ? (
        <ComposerMenu label={label} open={open} onOpenChange={(next) => { setOpenFor(next ? owner : null) }} trigger={button}>
          <MenuItem onClick={() => camera.current?.click()}><Camera size={14} aria-hidden="true" />{m.composer_attach_camera()}</MenuItem>
          <MenuItem onClick={() => files.current?.click()}><Paperclip size={14} aria-hidden="true" />{m.composer_attach_files()}</MenuItem>
        </ComposerMenu>
      ) : button}
    </>
  )
}
