import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

// Outils qui restent actifs après chaque tracé, jusqu'à V / Échap.
// On pré-verrouille l'outil natif d'Excalidraw au pointerdown : au pointerup,
// Excalidraw garde l'outil quand `activeTool.locked` est vrai.
const STICKY_TOOLS = new Set([
  'rectangle',
  'diamond',
  'ellipse',
  'arrow',
  'line',
  'freedraw',
  'text'
])

function isDrawingSurface(target: EventTarget | null): target is HTMLCanvasElement {
  return target instanceof HTMLCanvasElement && !!target.closest('.excalidraw')
}

export function attachToolLock(
  host: HTMLElement,
  getApi: () => ExcalidrawImperativeAPI | null
): () => void {
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (!isDrawingSurface(event.target)) return
    const instance = getApi()
    if (!instance) return
    let type: string | undefined
    let locked = false
    try {
      const tool = instance.getAppState().activeTool
      type = tool?.type
      locked = tool?.locked ?? false
    } catch {
      return
    }
    if (!type || locked || !STICKY_TOOLS.has(type)) return
    try {
      instance.setActiveTool({ type: type as 'rectangle', locked: true })
    } catch {
      /* ignore */
    }
  }
  host.addEventListener('pointerdown', onPointerDown, true)
  return () => host.removeEventListener('pointerdown', onPointerDown, true)
}
