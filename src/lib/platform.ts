export const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent)

export const revealLabel = isMac ? 'Révéler dans le Finder' : "Révéler dans l'Explorateur"

export const shortcuts = {
  newDrawing: isMac ? '⌘N' : 'Ctrl+N',
  import: isMac ? '⌘O' : 'Ctrl+O',
  newFolder: isMac ? '⌘⇧N' : 'Ctrl+Maj+N',
  save: isMac ? '⌘S' : 'Ctrl+S',
  toggleSidebar: isMac ? '⌘B' : 'Ctrl+B',
  toggleTheme: isMac ? '⌘⇧D' : 'Ctrl+Maj+D',
  fitAll: isMac ? '⌘T' : 'Ctrl+T'
} as const
