export const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent)

export const revealLabel = isMac ? 'Révéler dans le Finder' : "Révéler dans l'Explorateur"
