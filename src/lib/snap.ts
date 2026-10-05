import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

export type ScenePoint = { x: number; y: number }

// Un appui bref sur Control bascule l'aimantation (persistant) ;
// Control maintenu l'active temporairement. Les deux marchent pareil :
// le début du tracé se colle au point magnétisé, la fin aussi.
const SNAP_TOOLS = new Set([
  'rectangle',
  'diamond',
  'ellipse',
  'arrow',
  'line',
  'freedraw',
  'text'
])

const TAP_MS = 280
const MARKER_PX = 16
const SNAP_PX = 16

function isTypingTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null
  return !!target && !!target.closest?.('input, textarea, select, [contenteditable="true"]')
}

function isDrawingSurface(target: EventTarget | null): target is HTMLCanvasElement {
  return target instanceof HTMLCanvasElement && !!target.closest('.excalidraw')
}

function activeToolType(instance: ExcalidrawImperativeAPI | null): string | undefined {
  try {
    return instance?.getAppState()?.activeTool?.type ?? undefined
  } catch {
    return undefined
  }
}

function zoomOf(instance: ExcalidrawImperativeAPI): number {
  try {
    return instance.getAppState().zoom?.value || 1
  } catch {
    return 1
  }
}

function surfaceRect(host: HTMLElement): DOMRect {
  return (host.querySelector('.excalidraw__canvas') ?? host).getBoundingClientRect()
}

function sceneFromClient(
  instance: ExcalidrawImperativeAPI,
  host: HTMLElement,
  clientX: number,
  clientY: number
): ScenePoint | null {
  try {
    const appState = instance.getAppState()
    const zoom = appState.zoom?.value || 1
    const rect = surfaceRect(host)
    return {
      x: (clientX - rect.left) / zoom - (appState.scrollX ?? 0),
      y: (clientY - rect.top) / zoom - (appState.scrollY ?? 0)
    }
  } catch {
    return null
  }
}

function pointCustomData(el: ExcalidrawElement): boolean {
  const customData = (el as unknown as { customData?: Record<string, unknown> }).customData
  return customData?.['notingerPoint'] === true
}

function shapeCorners(x: number, y: number, w: number, h: number, type: string): ScenePoint[] {
  if (type === 'diamond') {
    // Sommets du losange (pas les coins de la boîte).
    return [
      { x: x + w / 2, y },
      { x: x + w, y: y + h / 2 },
      { x: x + w / 2, y: y + h },
      { x, y: y + h / 2 }
    ]
  }
  if (type === 'ellipse') {
    // Centre + 4 points cardinaux + 4 points diagonaux (45°) du cercle.
    const cx = x + w / 2
    const cy = y + h / 2
    const rx = w / 2
    const ry = h / 2
    const diag = Math.SQRT1_2
    return [
      { x: cx, y: cy },
      { x: cx, y },
      { x: x + w, y: cy },
      { x: cx, y: y + h },
      { x, y: cy },
      { x: cx + rx * diag, y: cy - ry * diag },
      { x: cx + rx * diag, y: cy + ry * diag },
      { x: cx - rx * diag, y: cy + ry * diag },
      { x: cx - rx * diag, y: cy - ry * diag }
    ]
  }
  return [
    { x, y },
    { x: x + w, y },
    { x, y: y + h },
    { x: x + w, y: y + h },
    { x: x + w / 2, y },
    { x: x + w, y: y + h / 2 },
    { x: x + w / 2, y: y + h },
    { x, y: y + h / 2 }
  ]
}

function collectSnapPoints(
  elements: readonly ExcalidrawElement[],
  excludeId?: string
): ScenePoint[] {
  const out: ScenePoint[] = []
  for (const el of elements) {
    if (el.isDeleted || el.id === excludeId || el.angle) continue
    if (el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw') {
      const pts = el.points
      if (pts.length === 0) continue
      out.push({ x: el.x + pts[0][0], y: el.y + pts[0][1] })
      const last = pts[pts.length - 1]
      if (pts.length > 1) out.push({ x: el.x + last[0], y: el.y + last[1] })
    } else if (el.type === 'rectangle' || el.type === 'diamond' || el.type === 'ellipse') {
      if (el.type === 'ellipse' && pointCustomData(el)) {
        // Point Notinger : seul son centre sert de cible.
        out.push({ x: el.x + el.width / 2, y: el.y + el.height / 2 })
      } else {
        out.push(...shapeCorners(el.x, el.y, el.width, el.height, el.type))
      }
    }
  }
  return out
}

function nearestSnapPoint(
  points: ScenePoint[],
  x: number,
  y: number,
  maxDist: number
): ScenePoint | null {
  let best: ScenePoint | null = null
  let bestDist = maxDist
  for (const point of points) {
    const dist = Math.hypot(point.x - x, point.y - y)
    if (dist <= bestDist) {
      bestDist = dist
      best = point
    }
  }
  return best
}

type StrokeSnap = {
  /** Point magnétisé sous le curseur au pointerdown (début du tracé). */
  start: ScenePoint | null
  /** Position brute du curseur au pointerdown. */
  origin: ScenePoint | null
  /** Position scène du curseur au pointerup (fin du tracé). */
  end: ScenePoint | null
}

function shapeBoxCorners(x: number, y: number, w: number, h: number): ScenePoint[] {
  return [
    { x, y },
    { x: x + w, y },
    { x, y: y + h },
    { x: x + w, y: y + h }
  ]
}

type Unbind = {
  /** Forme liée dont il faut retirer l'élément magnétisé. */
  elementId: string
  arrowId: string
}

type Correction = {
  patch: ExcalidrawElement
  unbinds: Unbind[]
}

function correctElement(
  el: ExcalidrawElement,
  all: readonly ExcalidrawElement[],
  threshold: number,
  snap: StrokeSnap
): Correction | null {
  if (el.angle || el.isDeleted) return null
  if (el.type === 'line' || el.type === 'arrow') {
    if (el.points.length < 2) return null
    let changed = false
    const unbinds: Unbind[] = []
    const pts = el.points.map((p) => [p[0], p[1]] as [number, number])
    let startBinding = el.startBinding
    if (snap.start) {
      pts[0] = [snap.start.x - el.x, snap.start.y - el.y]
      changed = true
      // L'aimantation prime : la liaison native d'Excalidraw retiendrait
      // l'extrémité sur le contour de la forme, pas sur le point visé.
      if (startBinding) {
        unbinds.push({ elementId: startBinding.elementId, arrowId: el.id })
        startBinding = null
      }
    }
    let endBinding = el.endBinding
    const last = pts[pts.length - 1]
    const endHit = nearestSnapPoint(
      collectSnapPoints(all, el.id),
      el.x + last[0],
      el.y + last[1],
      threshold
    )
    if (endHit) {
      pts[pts.length - 1] = [endHit.x - el.x, endHit.y - el.y]
      changed = true
      if (endBinding) {
        unbinds.push({ elementId: endBinding.elementId, arrowId: el.id })
        endBinding = null
      }
    }
    if (!changed) return null
    return {
      patch: { ...el, points: pts, startBinding, endBinding } as unknown as ExcalidrawElement,
      unbinds
    }
  }
  if (el.type === 'freedraw') {
    if (el.points.length === 0 || !snap.start) return null
    const pts = el.points.map((p) => [p[0], p[1]] as [number, number])
    pts[0] = [snap.start.x - el.x, snap.start.y - el.y]
    return {
      patch: { ...el, points: pts } as unknown as ExcalidrawElement,
      unbinds: []
    }
  }
  if (el.type === 'rectangle' || el.type === 'diamond' || el.type === 'ellipse') {
    const targets = collectSnapPoints(all, el.id)
    const box = shapeBoxCorners(el.x, el.y, el.width, el.height)
    const originCorner = snap.origin ? nearestSnapPoint(box, snap.origin.x, snap.origin.y, Infinity) : null
    let dx = 0
    let dy = 0
    if (originCorner && snap.start) {
      // L'angle cliqué (sous le curseur au pointerdown) se colle au point visé.
      dx = snap.start.x - originCorner.x
      dy = snap.start.y - originCorner.y
    }
    // Angle opposé : celui lâché au pointerup.
    const center = { x: el.x + el.width / 2, y: el.y + el.height / 2 }
    const opposite = originCorner
      ? { x: center.x * 2 - originCorner.x, y: center.y * 2 - originCorner.y }
      : snap.end
        ? nearestSnapPoint(box, snap.end.x, snap.end.y, Infinity)
        : null
    const released = opposite ? { x: opposite.x + dx, y: opposite.y + dy } : null
    const endHit =
      released && snap.end
        ? nearestSnapPoint(targets, released.x, released.y, threshold)
        : null
    if (!endHit) {
      if (!dx && !dy) return null
      return { patch: { ...el, x: el.x + dx, y: el.y + dy }, unbinds: [] }
    }
    // Redimensionne pour que les deux angles tombent pile sur leur point.
    const startCorner = opposite
      ? {
          x: center.x * 2 - opposite.x + dx,
          y: center.y * 2 - opposite.y + dy
        }
      : { x: el.x + dx, y: el.y + dy }
    const corners = [startCorner, endHit]
    const nextX = Math.min(corners[0].x, corners[1].x)
    const nextY = Math.min(corners[0].y, corners[1].y)
    const nextWidth = Math.abs(corners[1].x - corners[0].x)
    const nextHeight = Math.abs(corners[1].y - corners[0].y)
    if (nextWidth < 1 || nextHeight < 1) {
      return dx || dy ? { patch: { ...el, x: el.x + dx, y: el.y + dy }, unbinds: [] } : null
    }
    return {
      patch: { ...el, x: nextX, y: nextY, width: nextWidth, height: nextHeight },
      unbinds: []
    }
  }
  return null
}

export class SnapAssist {
  /** Quand un mode de placement externe (outil Point) veut l'anneau même hors outil natif. */
  forceSnap = false
  private ctrlHeld = false
  private ctrlDownAt = 0
  private ctrlUsed = false
  private armed = false
  private drawing = false
  private strokeBase = new Set<string>()
  private strokeNew = new Set<string>()
  private strokeSnap: StrokeSnap | null = null
  private marker: HTMLDivElement | null = null
  private badge: HTMLDivElement | null = null
  private host: HTMLElement | null = null
  private getApi: (() => ExcalidrawImperativeAPI | null) | null = null
  private getElements: (() => readonly ExcalidrawElement[]) | null = null

  attach(
    host: HTMLElement,
    getApi: () => ExcalidrawImperativeAPI | null,
    getElements: () => readonly ExcalidrawElement[]
  ): () => void {
    this.host = host
    this.getApi = getApi
    this.getElements = getElements

    const marker = document.createElement('div')
    marker.className = 'snap-marker'
    marker.style.display = 'none'
    host.appendChild(marker)
    this.marker = marker

    const badge = document.createElement('div')
    badge.className = 'snap-badge'
    badge.textContent = 'Aimantation active — Ctrl pour désactiver'
    badge.style.display = 'none'
    host.appendChild(badge)
    this.badge = badge

    const onPointerMove = (event: PointerEvent) => this.updateMarker(event)
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0 && event.button !== 2) return
      if (event.pointerType === 'mouse' && event.button === 2 && !event.ctrlKey) return
      if (!isDrawingSurface(event.target)) return
      this.strokeBase = new Set(getElements().map((el) => el.id))
      this.strokeNew.clear()
      this.drawing = true
      const instance = getApi()
      const tool = activeToolType(instance)
      if (instance && tool && SNAP_TOOLS.has(tool) && this.snapOn()) {
        if (this.ctrlHeld) this.ctrlUsed = true
        const scene = sceneFromClient(instance, host, event.clientX, event.clientY)
        const zoom = zoomOf(instance)
        const start =
          scene && zoom > 0
            ? nearestSnapPoint(collectSnapPoints(getElements()), scene.x, scene.y, SNAP_PX / zoom)
            : null
        this.strokeSnap = { start, origin: scene, end: null }
      } else {
        this.strokeSnap = null
      }
    }
    const endStroke = () => {
      if (!this.drawing) return
      this.drawing = false
      const snap = this.strokeSnap
      const ids = [...this.strokeNew]
      this.strokeNew.clear()
      this.strokeSnap = null
      if (!snap || ids.length === 0) return
      // Laisse Excalidraw terminer le tracé avant de recoller les extrémités.
      requestAnimationFrame(() => this.finishStroke(ids, snap))
    }
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0 && event.button !== 2) return
      const instance = getApi()
      if (this.drawing && this.strokeSnap && instance) {
        const end = sceneFromClient(instance, host, event.clientX, event.clientY)
        if (end) this.strokeSnap.end = end
      }
      endStroke()
    }
    const onBlur = () => {
      this.drawing = false
      this.strokeNew.clear()
      this.strokeSnap = null
      this.hideMarker()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'Control' &&
        !event.repeat &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        if (!this.ctrlHeld) {
          this.ctrlHeld = true
          this.ctrlDownAt = performance.now()
          this.ctrlUsed = false
        }
        return
      }
      if (isTypingTarget(event)) return
      if (event.key === 'Escape' || event.key === 'v' || event.key === 'V') {
        if (this.armed) {
          this.armed = false
          this.syncBadge()
        }
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Control') return
      this.ctrlHeld = false
      if (performance.now() - this.ctrlDownAt < TAP_MS && !this.ctrlUsed) {
        this.armed = !this.armed
        this.syncBadge()
      }
    }
    const onContextMenu = (event: MouseEvent) => {
      // Sur Mac, Control+clic équivaut à un clic droit : on le traite comme un
      // clic gauche normal (tracé / aimantation), jamais comme un menu.
      // Le menu reste accessible par vrai clic droit (sans Control).
      // On garde le menu natif dans les champs de saisie.
      if (!event.ctrlKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      event.stopPropagation()
    }
    const onLeave = () => this.hideMarker()
    const onWheel = () => this.hideMarker()

    host.addEventListener('pointermove', onPointerMove, true)
    host.addEventListener('pointerdown', onPointerDown, true)
    host.addEventListener('pointerleave', onLeave)
    host.addEventListener('wheel', onWheel, { capture: true, passive: true })
    host.addEventListener('contextmenu', onContextMenu, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerUp, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)

    return () => {
      host.removeEventListener('pointermove', onPointerMove, true)
      host.removeEventListener('pointerdown', onPointerDown, true)
      host.removeEventListener('pointerleave', onLeave)
      host.removeEventListener('wheel', onWheel, true)
      host.removeEventListener('contextmenu', onContextMenu, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerUp, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      marker.remove()
      badge.remove()
      this.marker = null
      this.badge = null
      this.host = null
      this.getApi = null
      this.getElements = null
    }
  }

  /** À appeler depuis le onChange Excalidraw : repère les éléments du tracé en cours. */
  trackChange(elements: readonly ExcalidrawElement[]): void {
    if (!this.drawing) return
    for (const el of elements) {
      if (!this.strokeBase.has(el.id)) this.strokeNew.add(el.id)
    }
  }

  snapOn(): boolean {
    return this.ctrlHeld || this.armed
  }

  /** Point magnétisé le plus proche d'une position scène, ou null. */
  findSnap(x: number, y: number): ScenePoint | null {
    const getElements = this.getElements
    const instance = this.getApi?.()
    if (!getElements || !instance) return null
    const zoom = zoomOf(instance)
    if (zoom <= 0) return null
    return nearestSnapPoint(collectSnapPoints(getElements()), x, y, SNAP_PX / zoom)
  }

  private syncBadge(): void {
    if (this.badge) this.badge.style.display = this.armed ? 'inline-flex' : 'none'
  }

  private hideMarker(): void {
    if (this.marker) this.marker.style.display = 'none'
  }

  private updateMarker(event: PointerEvent): void {
    const marker = this.marker
    const host = this.host
    const getApi = this.getApi
    const getElements = this.getElements
    if (!marker || !host || !getApi || !getElements || !this.snapOn()) {
      this.hideMarker()
      return
    }
    if (!isDrawingSurface(event.target)) {
      this.hideMarker()
      return
    }
    const instance = getApi()
    const tool = activeToolType(instance)
    if (!instance || !tool || (!SNAP_TOOLS.has(tool) && !this.forceSnap)) {
      this.hideMarker()
      return
    }
    let zoom = 1
    let scrollX = 0
    let scrollY = 0
    try {
      const appState = instance.getAppState()
      zoom = appState.zoom?.value || 1
      scrollX = appState.scrollX ?? 0
      scrollY = appState.scrollY ?? 0
    } catch {
      this.hideMarker()
      return
    }
    if (zoom <= 0) {
      this.hideMarker()
      return
    }
    const rect = surfaceRect(host)
    const sceneX = (event.clientX - rect.left) / zoom - scrollX
    const sceneY = (event.clientY - rect.top) / zoom - scrollY
    const hit = nearestSnapPoint(
      collectSnapPoints(getElements()),
      sceneX,
      sceneY,
      MARKER_PX / zoom
    )
    if (!hit) {
      this.hideMarker()
      return
    }
    const hostRect = host.getBoundingClientRect()
    marker.style.left = `${(hit.x + scrollX) * zoom + rect.left - hostRect.left}px`
    marker.style.top = `${(hit.y + scrollY) * zoom + rect.top - hostRect.top}px`
    marker.style.display = 'block'
  }

  private finishStroke(ids: string[], snap: StrokeSnap): void {
    const getElements = this.getElements
    const instance = this.getApi?.()
    if (!getElements || !instance) return
    const elements = getElements()
    const byId = new Map(elements.map((el) => [el.id, el]))
    const zoom = zoomOf(instance)
    const threshold = SNAP_PX / (zoom || 1)
    const patches = new Map<string, ExcalidrawElement>()
    // Formes dont la liaison native doit être relâchée : id forme -> ids flèches.
    const unbinds = new Map<string, Set<string>>()
    for (const id of ids) {
      const el = byId.get(id)
      if (!el) continue
      // Un point Notinger est déjà posé, centre aimanté au clic : la
      // correction de fin de tracé (angles des formes) le décalerait.
      if (pointCustomData(el)) continue
      const correction = correctElement(el, elements, threshold, snap)
      if (!correction) continue
      patches.set(id, correction.patch)
      for (const unbind of correction.unbinds) {
        let arrowIds = unbinds.get(unbind.elementId)
        if (!arrowIds) {
          arrowIds = new Set()
          unbinds.set(unbind.elementId, arrowIds)
        }
        arrowIds.add(unbind.arrowId)
      }
    }
    for (const [elementId, arrowIds] of unbinds) {
      const bound = patches.get(elementId) ?? byId.get(elementId)
      const boundElements = (
        bound as unknown as { boundElements?: readonly { id: string; type: string }[] | null }
      )?.boundElements
      if (!bound || !boundElements) continue
      const next = boundElements.filter(
        (ref) => !(ref.type === 'arrow' && arrowIds.has(ref.id))
      )
      if (next.length === boundElements.length) continue
      patches.set(elementId, { ...bound, boundElements: next } as unknown as ExcalidrawElement)
    }
    if (patches.size === 0) return
    try {
      instance.updateScene({ elements: elements.map((el) => patches.get(el.id) ?? el) })
    } catch {
      /* ignore */
    }
  }
}
