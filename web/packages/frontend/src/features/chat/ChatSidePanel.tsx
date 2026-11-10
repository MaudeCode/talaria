/**
 * TAL-373: the chat's right panel, a page host with Files, Agents, (TAL-571) Checkpoints, (TAL-1649) Skills and (TAL-2154) Todos when its setting is on. A later page (a terminal, say) is one more entry in
 * `pages`. The user's tab choice persists; when a session's panel first opens it shows Agents if agents are running or
 * need attention, else the last chosen page, and nothing switches it after that.
 */
import { useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { readPersisted, writePersisted } from '../../lib/persisted'
import { PanelPageHost, type PanelPage } from '../../shell/PanelPageHost'
import { useWorkspacePanelDefault } from '../../shell/useShellState'
import { useSetting } from '../../app/settings'
import { TodoList } from '../todos/TodosPage'
import type { Session } from '../../contracts'
import { FilesPage, type RestoredFiles } from '../workspace/FilesPage'
import { CheckpointsPage } from '../workspace/CheckpointsPage'
import { AgentsPage, useHasActiveAgents } from '../background/AgentsPage'
import { SessionSkillsPage } from '../skills/SessionSkillsPage'
import { onOpenFileRequest, peekOpenFileRequest } from '../workspace/openFileRequest'

const PAGE_KEY = 'talaria-right-panel-page'

/** The compiler caches this panel while the chat's turn-state frames leave its props unchanged (TAL-1388). `todoState` is ChatView's own
 * transcript field: a second transcript reader here would tear down the chat's live stream when its page is hidden (TAL-2154). */
export function ChatSidePanel({ sessionId, workspace, todoState, open, onToggle, onClose }: { sessionId: string; workspace: string | null | undefined; todoState: Session['todo_state']; open: boolean; onToggle: () => void; onClose: () => void }) {
  const hasActiveAgents = useHasActiveAgents(sessionId, open)
  useWorkspacePanelDefault(sessionId)
  const todosTab = useSetting('workspace_todos_tab') === true
  // This session's page, fixed on the panel's first open here; a later status change never moves it.
  const [chosen, setChosen] = useState<string | null>(null)
  const fallback = readPersisted(PAGE_KEY) ?? 'files'
  // TAL-571: the files the latest checkpoint restore rewrote; Files drops an unsaved draft of one.
  const [restored, setRestored] = useState<RestoredFiles | null>(null)
  // The first open picks this session's page once the agents are known, before its children render.
  if (open && chosen === null && hasActiveAgents !== undefined) setChosen(peekOpenFileRequest(sessionId) ? 'files' : hasActiveAgents ? 'agents' : fallback)
  // TAL-1968: a file a transcript block opens shows on Files.
  useEffect(() => onOpenFileRequest(() => { if (peekOpenFileRequest(sessionId)) setChosen('files') }), [sessionId])
  const pages: PanelPage[] = [
    { id: 'files', label: m.ws_panel_files(), render: (active) => <FilesPage workspace={workspace} sessionId={sessionId} active={active} restored={restored} /> },
    { id: 'agents', label: m.panel_agents(), render: (active) => <AgentsPage sessionId={sessionId} active={active} /> },
    { id: 'checkpoints', label: m.checkpoint_title(), render: (active) => <CheckpointsPage workspace={workspace} sessionId={sessionId} active={active} onRestored={(paths, restoredIn) => setRestored((r) => ({ seq: (r?.seq ?? 0) + 1, paths, workspace: restoredIn }))} /> },
    { id: 'skills', label: m.tab_skills(), render: (active) => <SessionSkillsPage sessionId={sessionId} active={active} /> },
    ...(todosTab ? [{ id: 'todos', label: m.tab_todos(), render: () => <div className="min-h-0 flex-1 overflow-y-auto p-3"><TodoList state={todoState} /></div> }] : []),
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
