import { m } from '../../paraglide/messages.js'
import { Button } from '../../ui/Button'
import { useSetting } from '../../app/queries'
import { openFeedback } from './FeedbackDialog'

const BADGE = 'settings-version-badge inline-flex items-center px-2 py-[3px] rounded-(--r-sm) bg-surface-subtle text-muted text-[11px] font-semibold font-mono tracking-[.02em] border border-border'

/** TAL-1691: Settings > About, the installed versions, docs, shortcuts and feedback. */
export function AboutSection() {
  const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl'
  const web = useSetting('webui_version')
  const agent = useSetting('agent_version')
  return (
    <div className="flex flex-col gap-4 text-sm" data-section="about">
      {(web || agent) && <section>
        <h2 className="mb-1 font-semibold text-text">{m.settings_group_versions()}</h2>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1">
          {web && <><dt className="text-muted">Talaria Web</dt><dd><span className={BADGE} data-testid="webui-version">{web}</span></dd></>}
          {agent && <><dt className="text-muted">Hermes Agent</dt><dd><span className={BADGE} data-testid="agent-version">{agent}</span></dd></>}
        </dl>
      </section>}
      <section>
        <Button onClick={openFeedback}>{m.feedback_send_open()}</Button>
      </section>
      <section>
        <h2 className="mb-1 font-semibold text-text">{m.help_docs()}</h2>
        <ul className="list-disc pl-5 text-muted">
          <li><a className="text-accent-text underline" href="https://github.com/MaudeCode/talaria/blob/main/web/README.md" target="_blank" rel="noopener noreferrer">README</a></li>
          <li><a className="text-accent-text underline" href="https://github.com/MaudeCode/talaria/blob/main/web/docs/troubleshooting.md" target="_blank" rel="noopener noreferrer">Troubleshooting</a></li>
        </ul>
      </section>
      <section>
        <h2 className="mb-1 font-semibold text-text">{m.help_shortcuts()}</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt><kbd className="rounded border border-border bg-surface px-1.5 font-mono text-xs">{mod}+K</kbd></dt><dd className="text-muted">{m.help_shortcut_new_chat()}</dd>
          <dt><kbd className="rounded border border-border bg-surface px-1.5 font-mono text-xs">{mod}+B</kbd></dt><dd className="text-muted">{m.help_shortcut_sidebar()}</dd>
          <dt><kbd className="rounded border border-border bg-surface px-1.5 font-mono text-xs">{mod}+/</kbd></dt><dd className="text-muted">{m.help_shortcut_composer()}</dd>
          <dt><kbd className="rounded border border-border bg-surface px-1.5 font-mono text-xs">{mod}+,</kbd></dt><dd className="text-muted">{m.help_shortcut_settings()}</dd>
        </dl>
      </section>
    </div>
  )
}
