import { type Dispatch, type SetStateAction } from 'react'
import { SlidersHorizontal, TerminalSquare } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { cn } from '../../ui/cn'
import { ProfileMenu } from '../../shell/ProfileMenu'
import { ContextRow, ExecutionModeChip, ModelChip, ReasoningChip, ToolsetsChip, WorkspaceChip, type ContextFigures } from './chips'
import type { ComposerProps } from './Composer'

type ControlsProps = Pick<ComposerProps, 'sessionId' | 'session' | 'settings' | 'pendingChoices' | 'onModelChange' | 'onReasoningChange' | 'reasoning' | 'reasoningLevels' | 'reasoningSupported' | 'onWorkspaceChange' | 'onNewWorktreeChat' | 'onRemoveWorktree' | 'onToolsetsChange' | 'terminalOpen' | 'onToggleTerminal'> & {
  onExecutionModeChange: ComposerProps['onExecutionModeChange']
  placement: 'footer' | 'panel' | 'strip'
  answering: boolean
  stage: 'full' | 'icons' | 'burger'
  phone: boolean
  collapsed: boolean
  configOpen: boolean
  setConfigOpen: Dispatch<SetStateAction<boolean>>
  context: ContextFigures
}

const MESSAGE_ONLY_CONTROLS = new Set(['hide_composer_attach', 'hide_composer_mic', 'hide_composer_profile', 'hide_composer_workspace', 'hide_composer_model', 'hide_composer_reasoning'])
export function hideComposerControl(settings: ComposerProps['settings'], answering: boolean, key: string): boolean {
  return (answering && MESSAGE_ONLY_CONTROLS.has(key)) || !!settings?.[key]
}

/** Stable control groups at the existing DOM positions around the input and send actions. */
export function ComposerControls({ placement, sessionId, session, settings, pendingChoices, onExecutionModeChange, onModelChange, onReasoningChange, reasoning, reasoningLevels, reasoningSupported = true, onWorkspaceChange, onNewWorktreeChat, onRemoveWorktree, onToolsetsChange, terminalOpen, onToggleTerminal, answering, stage, phone, collapsed, configOpen, setConfigOpen, context }: ControlsProps) {
  const hide = (key: string) => hideComposerControl(settings, answering, key)
  const modelChoice = { ...(session?.model ? { model: session.model, optionId: session.model_option_id ?? null } : { model: pendingChoices?.model ?? null, optionId: pendingChoices?.model ?? null }), servedModel: session?.served_model ?? null }
  const modeChip = !sessionId && onExecutionModeChange ? <ExecutionModeChip value={pendingChoices?.execution_mode ?? 'normal'} onChange={onExecutionModeChange} />
    : session?.execution_mode && session.execution_mode !== 'normal' ? <ExecutionModeChip value={session.execution_mode} /> : null
  if (placement === 'footer') return (
    <div className="composer-left flex items-center gap-1 min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] max-[641px]:flex-[1_1_auto] max-[641px]:w-auto max-[641px]:flex-nowrap max-[641px]:items-center max-[641px]:gap-x-2.5 max-[641px]:gap-y-0 max-[641px]:max-h-none max-[641px]:[-webkit-overflow-scrolling:touch] max-[341px]:gap-x-0.5">
      {!hide('hide_composer_model') && <div className="composer-model-wrap"><ModelChip {...modelChoice} onChange={onModelChange} /></div>}
      {!session?.read_only && !hide('hide_composer_reasoning') && reasoningSupported && <div className="composer-reasoning-wrap"><ReasoningChip value={reasoning} levels={reasoningLevels} onChange={onReasoningChange} /></div>}
      <button className="icon-btn composer-mobile-config-btn has-tooltip" id="composerMobileConfigBtn" type="button" data-tooltip={m.composer_config_title()} aria-label={m.composer_config_title()} aria-expanded={configOpen} aria-controls="composerMobileConfigPanel" onClick={() => setConfigOpen((o) => !o)}>
        <SlidersHorizontal size={16} aria-hidden="true" />
      </button>
    </div>
  )
  if (placement === 'panel') return (
    <div className={cn('composer-mobile-config-panel', configOpen && 'open')} id="composerMobileConfigPanel" role="group" aria-label={m.composer_config_title()}>
      {stage === 'burger' && !hide('hide_composer_model') && <ModelChip row {...modelChoice} onChange={onModelChange} />}
      {stage === 'burger' && !session?.read_only && !hide('hide_composer_reasoning') && reasoningSupported && <ReasoningChip row value={reasoning} levels={reasoningLevels} onChange={onReasoningChange} />}
      {/* The chat header carries the terminal toggle above phone width. */}
      {stage === 'burger' && phone && <button type="button" className={cn('icon-btn', terminalOpen && 'active')} id="btnTerminal" title={m.composer_terminal_toggle()} aria-label={m.composer_terminal_toggle()} aria-pressed={terminalOpen} onClick={() => { setConfigOpen(false); onToggleTerminal() }}><TerminalSquare size={16} aria-hidden="true" /><span className="composer-mobile-config-value">{m.composer_terminal_toggle()}</span></button>}
      {configOpen && stage === 'burger' && !hide('hide_composer_context') && <ContextRow {...context} />}
    </div>
  )
  return (<>
    {!collapsed && (!hide('hide_composer_workspace') || !hide('hide_composer_toolsets') || !hide('hide_composer_profile') || modeChip) && (
        <div className="composer-strip" role="group" aria-label={m.composer_config_title()}>
          {!hide('hide_composer_workspace') && <WorkspaceChip value={session?.workspace ?? pendingChoices?.workspace ?? settings?.default_workspace} name={session ? session.workspace_name ?? null : undefined} onChange={onWorkspaceChange} onNewWorktree={onNewWorktreeChat} onRemoveWorktree={onRemoveWorktree} />}
          {!session?.read_only && !hide('hide_composer_toolsets') && <ToolsetsChip sessionId={sessionId ?? undefined} value={session?.enabled_toolsets ?? pendingChoices?.enabled_toolsets ?? null} onChange={onToolsetsChange} />}
          {modeChip}
          {!hide('hide_composer_profile') && <ProfileMenu />}
        </div>
    )}
  </>)
}
