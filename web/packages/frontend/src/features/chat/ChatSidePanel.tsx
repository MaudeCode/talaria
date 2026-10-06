/**
 * TAL-373: the chat's right panel, a page host with Files, Agents and (TAL-571) Checkpoints. A later page (a terminal, say) is one more entry in
 * `pages`. The user's tab choice persists; when a session's panel first opens it shows Agents if agents are running or
 * need attention, else the last chosen page, and nothing switches it after that.
 */
import { useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { readPersisted, writePersisted } from '../../lib/persisted'
import { PanelPageHost, type PanelPage } from '../../shell/PanelPageHost'
import { FilesPage, type RestoredFiles } from '../workspace/FilesPage'
import { CheckpointsPage } from '../workspace/CheckpointsPage'
import { AgentsPage, useHasActiveAgents } from '../background/AgentsPage'

const PAGE_KEY = 'talaria-right-panel-page'

export function ChatSidePanel({ sessionId, workspace, open, onToggle, onClose }: { sessionId: string; workspace: string | null | undefined; open: boolean; onToggle: () => void; onClose: () => void }) {
  const hasActiveAgents = useHasActiveAgents(sessionId)
  // This session's page, fixed on the panel's first open here; a later status change never moves it.
  const [chosen, setChosen] = useState<string | null>(null)
  const fallback = readPersisted(PAGE_KEY) ?? 'files'
  // TAL-571: the files the latest checkpoint restore rewrote; Files drops an unsaved draft of one.
  const [restored, setRestored] = useState<RestoredFiles | null>(null)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first open picks this session's page once the agents are known
    if (open && chosen === null && hasActiveAgents !== undefined) setChosen(hasActiveAgents ? 'agents' : fallback)
  }, [open, chosen, hasActiveAgents, fallback])
  const pages: PanelPage[] = [
    { id: 'files', label: m.ws_panel_files(), render: (active) => <FilesPage workspace={workspace} sessionId={sessionId} active={active} restored={restored} /> },
    { id: 'agents', label: m.panel_agents(), render: (active) => <AgentsPage sessionId={sessionId} active={active} /> },
    { id: 'checkpoints', label: m.checkpoint_title(), render: (active) => <CheckpointsPage workspace={workspace} sessionId={sessionId} active={active} onRestored={(paths) => setRestored((r) => ({ seq: (r?.seq ?? 0) + 1, paths }))} /> },
  ]
  return (
    <PanelPageHost
      open={open}
      onToggle={onToggle}
      onClose={onClose}
      label={m.panel_label()}
      pages={pages}
      activeId={chosen ?? fallback}
      onSelect={(id) => { setChosen(id); writePersisted(PAGE_KEY, id) }}
    />
  )
}
