import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState } from '@excalidraw/excalidraw/types'

// Mémoire des styles : chaque choix de trait / épaisseur / remplissage /
// police (avec ou sans sélection) est retenu et ré-appliqué à la prochaine
// forme tracée à l'outil, même si le défaut natif a divergé entre-temps.
const STAMP_TOOLS = new Set([
  'rectangle',
  'diamond',
  'ellipse',
  'arrow',
  'line',
  'freedraw',
  'text'
])

const MEMO_KEYS = [
  'strokeColor',
  'backgroundColor',
  'fillStyle',
  'strokeWidth',
  'strokeStyle',
  'roughness',
  'opacity',
  'fontFamily',
  'fontSize',
  'textAlign'
] as const

type MemoKey = (typeof MEMO_KEYS)[number]
type Memo = Record<MemoKey, unknown>

function readMemory(appState: AppState): Memo {
  return {
    strokeColor: appState.currentItemStrokeColor,
    backgroundColor: appState.currentItemBackgroundColor,
    fillStyle: appState.currentItemFillStyle,
    strokeWidth: appState.currentItemStrokeWidth,
    strokeStyle: appState.currentItemStrokeStyle,
    roughness: appState.currentItemRoughness,
    opacity: appState.currentItemOpacity,
    fontFamily: appState.currentItemFontFamily,
    fontSize: appState.currentItemFontSize,
    textAlign: appState.currentItemTextAlign
  }
}

function isNotingerPoint(el: ExcalidrawElement): boolean {
  return (
    (el as unknown as { customData?: Record<string, unknown> }).customData?.['notingerPoint'] ===
    true
  )
}

export class StyleMemory {
  private knownIds = new Set<string>()

  /** À appeler depuis le onChange Excalidraw, après les autres traitements. */
  onChange(
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    apply: (next: ExcalidrawElement[]) => void
  ): void {
    // 1. Retient les défauts courants (choix panneau, avec ou sans sélection).
    const mem = readMemory(appState)

    // 2. Oublie les éléments disparus.
    const ids = new Set<string>()
    for (const el of elements) ids.add(el.id)
    for (const id of this.knownIds) {
      if (!ids.has(id)) this.knownIds.delete(id)
    }

    // 3. Ne tamponne que les créations à l'outil de dessin : le coller,
    //    la sélection et nos insertions (images PDF, points) gardent leur style.
    const tool = appState.activeTool?.type
    if (!tool || !STAMP_TOOLS.has(tool)) {
      for (const id of ids) this.knownIds.add(id)
      return
    }

    let dirty = false
    const next = elements.map((el) => {
      if (this.knownIds.has(el.id)) return el
      this.knownIds.add(el.id)
      if (el.isDeleted || el.type === 'image' || isNotingerPoint(el)) return el
      if (!STAMP_TOOLS.has(el.type)) return el
      let patch: Record<MemoKey, unknown> | null = null
      const values = el as unknown as Record<string, unknown>
      for (const key of MEMO_KEYS) {
        if (key in el && values[key] !== mem[key]) {
          if (!patch) patch = {} as Record<MemoKey, unknown>
          patch[key] = mem[key]
        }
      }
      if (!patch) return el
      dirty = true
      return { ...el, ...patch } as ExcalidrawElement
    })
    if (dirty) apply(next)
  }
}
