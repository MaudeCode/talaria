// Pre-paint appearance. Loaded as a blocking classic script in <head> (see
// routes/__root.tsx) so the document paints in the persisted theme and skin
// before the module entry runs; without it a dark-theme reload flashes light.
// The module entry (theme/boot.ts) then applies the full, validated appearance.
// Unknown skins match no CSS and unknown themes count as dark, as legacy did.
;(function () {
  var root = document.documentElement
  try {
    var theme = (localStorage.getItem('hermes-theme') || 'dark').toLowerCase()
    if (theme === 'system') theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    var dark = theme !== 'light'
    if (dark) root.classList.add('dark')
    root.style.colorScheme = dark ? 'dark' : 'light'
    var skin = (localStorage.getItem('hermes-skin') || '').toLowerCase()
    if (skin && skin !== 'default') root.dataset.skin = skin
    if (localStorage.getItem('hermes-webui-sidebar-collapsed') === '1') root.dataset.sidebarCollapsed = '1'
    root.dataset.workspacePanel = localStorage.getItem('hermes-webui-workspace-panel') === 'open' ? 'open' : 'closed'
  } catch {
    root.classList.add('dark')
  }
})()
