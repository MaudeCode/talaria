// Hello Panel: the smallest useful protocol v1 extension.
Hermes.connect().then(async (hermes) => {
  const { values } = await hermes.call('settings.get')
  document.getElementById('greeting').textContent = values.greeting
  const session = await hermes.call('session.current')
  document.getElementById('session').textContent = session.sessionId ? `Current session: ${session.sessionId}` : 'No session open'

  const counterEl = document.getElementById('counter')
  const render = async () => {
    if (!values.show_counter) { counterEl.textContent = ''; return }
    const { value } = await hermes.call('storage.get', { key: 'clicks' })
    counterEl.textContent = `Clicks so far: ${value ?? 0}`
  }
  await render()
  document.getElementById('bump').addEventListener('click', async () => {
    const { value } = await hermes.call('storage.get', { key: 'clicks' })
    await hermes.call('storage.set', { key: 'clicks', value: String((Number(value) || 0) + 1) })
    await render()
  })
  document.getElementById('toast').addEventListener('click', () => {
    hermes.call('toast.show', { text: 'Hello from the sandbox' }).catch((e) => console.warn('toast denied', e))
  })
  const log = document.getElementById('events')
  for (const name of ['turn:start', 'turn:complete', 'turn:error', 'turn:cancel']) {
    hermes.on(name, (event) => {
      const li = document.createElement('li')
      li.textContent = `${name} · ${event.sessionId} · ${new Date(event.timestamp * 1000).toLocaleTimeString()}`
      log.prepend(li)
    })
  }
}).catch((e) => {
  document.getElementById('session').textContent = `Host handshake failed: ${e.message}`
})
