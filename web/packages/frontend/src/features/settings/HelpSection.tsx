import { m } from '../../paraglide/messages.js'

export function HelpSection() {
  const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl'
  return (
    <div className="flex flex-col gap-4 text-sm" data-section="help">
      <section>
        <h2 className="mb-1 font-semibold text-text">{m.help_docs()}</h2>
        <ul className="list-disc pl-5 text-muted">
          <li><a className="text-accent-text underline" href="https://github.com/nesquena/hermes-webui#readme" target="_blank" rel="noopener noreferrer">README</a></li>
          <li><a className="text-accent-text underline" href="https://github.com/nesquena/hermes-webui/blob/master/docs/troubleshooting.md" target="_blank" rel="noopener noreferrer">Troubleshooting</a></li>
          <li><a className="text-accent-text underline" href="https://github.com/nesquena/hermes-webui/issues" target="_blank" rel="noopener noreferrer">{m.help_report()}</a></li>
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
