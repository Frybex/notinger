import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import Icon from './Icon'
import type { SnapAssist } from '../lib/snap'

type PointToolProps = {
  hostRef: { current: HTMLElement | null }
  apiRef: { current: ExcalidrawImperativeAPI | null }
  /** API publiée quand Excalidraw est prêt (peut arriver après le montage). */
  api: ExcalidrawImperativeAPI | null
  renderKey: number
  getSnap: () => SnapAssist
  onError: (message: string) => void
}

const MIN_SIZE = 4
const MAX_SIZE = 48
const DEFAULT_SIZE = 12
const SIZE_KEY = 'notinger.pointSize'
const SHORTCUT = 'm'

function clampSize(value: number): number {
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(value)))
}

function readSize(): number {
  try {
    const parsed = Number.parseInt(localStorage.getItem(SIZE_KEY) ?? '', 10)
    if (Number.isFinite(parsed)) return clampSize(parsed)
  } catch {
    /* ignore */
  }
  return DEFAULT_SIZE
}

function findPointAnchor(host: HTMLElement | null): HTMLElement | null {
  if (!host) return null
  // Avec les formes, juste après l'ellipse.
  const ellipse = host.querySelector('[data-testid="toolbar-ellipse"]')
  if (ellipse) {
    const tool = ellipse.closest('label.ToolIcon, button.ToolIcon, .ToolIcon')
    if (tool) return tool as HTMLElement
  }
  const img = host.querySelector('.imgmenu-tool')
  if (img) return img as HTMLElement
  const native = host.querySelector('[data-testid="toolbar-image"]')
  if (!native) return null
  const tool = native.closest('label.ToolIcon, button.ToolIcon, .ToolIcon')
  return (tool ?? native) as HTMLElement
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && !!el.closest?.('input, textarea, select, [contenteditable="true"]')
}

function isPointElement(el: ExcalidrawElement): boolean {
  if (el.type !== 'ellipse' || el.isDeleted) return false
  return (
    (el as unknown as { customData?: Record<string, unknown> }).customData?.['notingerPoint'] ===
    true
  )
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/**
 * Le curseur de taille prend la place de la commande native « Largeur du
 * contour » : on retrouve son fieldset pour s'insérer juste devant.
 */
function findStrokeWidthFieldset(panel: HTMLElement): HTMLElement | null {
  const probe = panel.querySelector('[data-testid="strokeWidth-thin"]')
  return (probe?.closest('fieldset') as HTMLElement | null) ?? null
}

export default function PointTool({
  hostRef,
  apiRef,
  api,
  renderKey,
  getSnap,
  onError
}: PointToolProps) {
  const [slotEl, setSlotEl] = useState<HTMLSpanElement | null>(null)
  const [panelSlotEl, setPanelSlotEl] = useState<HTMLSpanElement | null>(null)
  const [placing, setPlacing] = useState(false)
  const [dotSize, setDotSize] = useState(readSize)
  const [selectedSize, setSelectedSize] = useState<number | null>(null)
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([])
  const [pointsOnlySelected, setPointsOnlySelected] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [previewColor, setPreviewColor] = useState('#1e1e1e')

  const sizeRef = useRef(dotSize)
  const placingRef = useRef(false)

  useEffect(() => {
    sizeRef.current = dotSize
    try {
      localStorage.setItem(SIZE_KEY, String(dotSize))
    } catch {
      /* ignore */
    }
  }, [dotSize])

  useEffect(() => {
    placingRef.current = placing
  }, [placing])

  // Quitte le mode point au changement de schéma.
  useEffect(() => {
    setPlacing(false)
  }, [renderKey])

  // Pastille dans la barre d'outils, avec les formes après l'ellipse.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let slot: HTMLSpanElement | null = null
    const tryAttach = () => {
      if (slot?.isConnected) return true
      if (slot) {
        slot = null
        setSlotEl(null)
      }
      const anchor = findPointAnchor(host)
      if (anchor?.parentElement) {
        slot = document.createElement('span')
        slot.className = 'point-tool-slot'
        slot.style.display = 'contents'
        anchor.after(slot)
        setSlotEl(slot)
        return true
      }
      return false
    }
    tryAttach()
    const observer = new MutationObserver(() => {
      tryAttach()
    })
    observer.observe(host, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      if (slot) {
        setSlotEl(null)
        slot.remove()
        slot = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey])

  // Le panneau de gauche suit l'outil point : actif pendant le placement ou
  // quand la sélection ne contient que des points.
  const panelActive = placing || pointsOnlySelected

  // Classe hôte : masque les commandes natives sans objet pour un point
  // (couleur de fond, remplissage, épaisseur de trait) via styles.css.
  useEffect(() => {
    const host = hostRef.current
    if (!host || !panelActive) return
    host.classList.add('point-mode')
    return () => host.classList.remove('point-mode')
  }, [panelActive, hostRef, renderKey])

  // Insère le curseur de taille à la place de la largeur du contour.
  useEffect(() => {
    const host = hostRef.current
    if (!host || !panelActive) return
    let disposed = false
    let slot: HTMLSpanElement | null = null

    const apply = () => {
      if (disposed) return
      const panel = host.querySelector<HTMLElement>('.excalidraw .panelColumn')
      if (!panel) return
      const anchor = findStrokeWidthFieldset(panel)
      if (!anchor) return
      let next = slot
      if (!next) {
        next = document.createElement('span')
        next.className = 'point-panel-slot'
        next.style.display = 'contents'
        slot = next
        setPanelSlotEl(next)
      }
      if (
        next.parentElement !== anchor.parentElement ||
        next.nextElementSibling !== anchor
      ) {
        anchor.before(next)
      }
    }

    apply()
    const observer = new MutationObserver(apply)
    observer.observe(host, { childList: true, subtree: true })
    return () => {
      disposed = true
      observer.disconnect()
      if (slot) {
        slot.remove()
        slot = null
        setPanelSlotEl(null)
      }
    }
  }, [panelActive, hostRef, renderKey])

  const startPlacing = useCallback(() => {
    // Outil ellipse natif : le panneau de gauche (couleur, opacité…) s'affiche
    // exactement comme pour les autres formes ; les clics posent des points.
    try {
      apiRef.current?.setActiveTool({ type: 'ellipse', locked: true })
    } catch {
      /* ignore */
    }
    setPlacing(true)
  }, [apiRef])

  const exitToSelection = useCallback(() => {
    try {
      apiRef.current?.setActiveTool({ type: 'selection', locked: false })
    } catch {
      /* ignore */
    }
    setPlacing(false)
  }, [apiRef])

  // Suit l'outil actif (sortie du mode point), les points sélectionnés et
  // garantit un point toujours plein : couleur de fond = couleur du trait.
  useEffect(() => {
    const instance = api
    if (!instance) return
    let fillRaf: number | null = null

    const syncFill = () => {
      fillRaf = null
      try {
        const latest = instance.getSceneElements()
        const ids = new Set<string>()
        for (const el of latest) {
          if (isPointElement(el) && el.backgroundColor !== el.strokeColor) ids.add(el.id)
        }
        if (ids.size === 0) return
        instance.updateScene({
          elements: latest.map((el) =>
            ids.has(el.id) ? ({ ...el, backgroundColor: el.strokeColor } as ExcalidrawElement) : el
          ) as never
        })
      } catch {
        /* ignore */
      }
    }

    const off = instance.onChange((elements, appState) => {
      const tool: string | undefined = appState.activeTool?.type
      if (tool && tool !== 'ellipse') setPlacing(false)
      const zoomValue = appState.zoom?.value
      if (typeof zoomValue === 'number' && zoomValue > 0) {
        setZoom((previous) => (Math.abs(previous - zoomValue) < 0.0001 ? previous : zoomValue))
      }
      const selected = (appState.selectedElementIds ?? {}) as Record<string, unknown>
      const ids: string[] = []
      let selectedCount = 0
      let selectedSize: number | null = null
      let selectedStroke: string | null = null
      let sizesMixed = false
      let strokesMixed = false
      let hasHollow = false
      for (const el of elements) {
        if (isPointElement(el) && el.backgroundColor !== el.strokeColor) hasHollow = true
        if (!selected[el.id] || el.isDeleted) continue
        selectedCount += 1
        if (!isPointElement(el)) continue
        ids.push(el.id)
        if (el.width === el.height) {
          if (selectedSize === null) selectedSize = el.width
          else if (selectedSize !== el.width) sizesMixed = true
        }
        if (selectedStroke === null) selectedStroke = el.strokeColor
        else if (selectedStroke !== el.strokeColor) strokesMixed = true
      }
      setSelectedIds((previous) => (sameIds(previous, ids) ? previous : ids))
      const pointsOnly = selectedCount > 0 && selectedCount === ids.length
      setPointsOnlySelected(pointsOnly)
      // Le curseur reflète la taille du point sélectionné, comme la largeur
      // de trait native reflète la forme sélectionnée.
      const uniform = pointsOnly && !sizesMixed && selectedSize !== null ? clampSize(selectedSize) : null
      setSelectedSize((previous) => (previous === uniform ? previous : uniform))
      // Aperçu : couleur du point tel qu'il sera posé.
      const color =
        pointsOnly && !strokesMixed && selectedStroke
          ? selectedStroke
          : appState.currentItemStrokeColor || '#1e1e1e'
      setPreviewColor((previous) => (previous === color ? previous : color))
      if (hasHollow && fillRaf === null) {
        fillRaf = requestAnimationFrame(syncFill)
      }
    })
    return () => {
      off()
      if (fillRaf !== null) cancelAnimationFrame(fillRaf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, renderKey])

  // Raccourci clavier de l'outil.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      if (event.key === SHORTCUT || event.key === SHORTCUT.toUpperCase()) {
        if (placingRef.current) exitToSelection()
        else startPlacing()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [exitToSelection, startPlacing])

  const applyToSelected = useCallback(
    (nextSize: number) => {
      setDotSize(nextSize)
      if (selectedIds.length > 0) setSelectedSize(nextSize)
      const instance = apiRef.current
      if (!instance) return
      const elements = instance.getSceneElements()
      const ids = new Set(selectedIds)
      if (ids.size === 0) return
      let dirty = false
      const next = elements.map((el) => {
        if (!ids.has(el.id) || !isPointElement(el)) return el
        if (el.width === nextSize && el.height === nextSize) return el
        const cx = el.x + el.width / 2
        const cy = el.y + el.height / 2
        dirty = true
        return {
          ...el,
          x: cx - nextSize / 2,
          y: cy - nextSize / 2,
          width: nextSize,
          height: nextSize
        }
      })
      if (!dirty) return
      try {
        instance.updateScene({ elements: next as never })
      } catch (cause) {
        onError(`Point impossible : ${String(cause)}`)
      }
    },
    [apiRef, onError, selectedIds]
  )

  const placeAt = useCallback(
    (clientX: number, clientY: number) => {
      const instance = apiRef.current
      const host = hostRef.current
      if (!instance || !host) {
        onError('Plan de travail non prêt.')
        return
      }
      let zoom = 1
      let scrollX = 0
      let scrollY = 0
      let stroke = '#1e1e1e'
      try {
        const appState = instance.getAppState()
        zoom = appState.zoom?.value || 1
        scrollX = appState.scrollX ?? 0
        scrollY = appState.scrollY ?? 0
        stroke = appState.currentItemStrokeColor ?? stroke
      } catch {
        return
      }
      if (zoom <= 0) return
      const surface = host.querySelector('.excalidraw__canvas') ?? host
      const rect = surface.getBoundingClientRect()
      let x = (clientX - rect.left) / zoom - scrollX
      let y = (clientY - rect.top) / zoom - scrollY
      const snap = getSnap()
      if (snap.snapOn()) {
        const hit = snap.findSnap(x, y)
        if (hit) {
          x = hit.x
          y = hit.y
        }
      }
      const size = sizeRef.current
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
      const nonce = () => Math.floor(Math.random() * 2 ** 31)
      try {
        instance.updateScene({
          elements: [
            ...instance.getSceneElements(),
            {
              id,
              type: 'ellipse',
              x: x - size / 2,
              y: y - size / 2,
              width: size,
              height: size,
              angle: 0,
              strokeColor: stroke,
              backgroundColor: stroke,
              fillStyle: 'solid',
              strokeWidth: 2,
              strokeStyle: 'solid',
              roughness: 0,
              opacity: 100,
              groupIds: [],
              frameId: null,
              index: null,
              roundness: null,
              boundElements: null,
              link: null,
              locked: false,
              customData: { notingerPoint: true },
              seed: nonce(),
              version: 1,
              versionNonce: nonce(),
              isDeleted: false,
              updated: Date.now()
            } as never
          ]
        })
      } catch (cause) {
        onError(`Point impossible : ${String(cause)}`)
      }
    },
    [apiRef, hostRef, getSnap, onError]
  )

  useEffect(() => {
    const snap = getSnap()
    snap.forceSnap = placing
    if (!placing) return
    const host = hostRef.current
    if (!host) {
      setPlacing(false)
      return
    }
    host.classList.add('point-placing')
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      if (event.key === 'Escape') {
        // Échap ferme d'abord les fenêtres (couleur, etc.).
        if ((event.target as HTMLElement | null)?.closest?.('.properties-content')) return
        exitToSelection()
        return
      }
      if (event.key === 'v' || event.key === 'V') exitToSelection()
    }
    window.addEventListener('keydown', onKey, true)
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0 && event.button !== 2) return
      if (event.pointerType === 'mouse' && event.button === 2 && !event.ctrlKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest?.('.point-tool')) return
      if (target?.closest?.('.ToolIcon, .pdfov-bar, .pdf-hint')) {
        setPlacing(false)
        return
      }
      if (!(target instanceof HTMLCanvasElement) || !target.closest('.excalidraw')) return
      // Un autre outil a repris la main (raccourci clavier) : rend le clic.
      try {
        const tool: string | undefined = apiRef.current?.getAppState()?.activeTool?.type
        if (tool && tool !== 'ellipse') {
          setPlacing(false)
          return
        }
      } catch {
        /* ignore */
      }
      event.preventDefault()
      event.stopPropagation()
      placeAt(event.clientX, event.clientY)
    }
    host.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      host.classList.remove('point-placing')
      window.removeEventListener('keydown', onKey, true)
      host.removeEventListener('pointerdown', onPointerDown, true)
      getSnap().forceSnap = false
    }
  }, [placing, hostRef, apiRef, getSnap, placeAt, exitToSelection])

  // Aperçu à l'échelle écran (taille voulue × zoom courant), plafonné pour
  // ne pas déformer le panneau.
  const previewSize = Math.min(96, (selectedSize ?? dotSize) * zoom)

  return (
    <>
      {slotEl
        ? createPortal(
            <button
              type="button"
              className={`ToolIcon point-tool${placing ? ' point-tool-active' : ''}`}
              title={`Point (${SHORTCUT.toUpperCase()}) — placer des points`}
              onClick={() => {
                if (placing) exitToSelection()
                else startPlacing()
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="ToolIcon__icon" aria-hidden="true">
                <Icon name="point" size={16} />
                <span className="ToolIcon__keybinding">{SHORTCUT.toUpperCase()}</span>
              </div>
            </button>,
            slotEl
          )
        : null}
      {panelSlotEl && panelActive
        ? createPortal(
            <fieldset className="point-size-fieldset">
              <div className="point-size-head">
                <span>Taille du point</span>
                <span className="point-size-preview" aria-hidden="true">
                  <span
                    className="point-size-preview-dot"
                    style={{
                      width: `${previewSize}px`,
                      height: `${previewSize}px`,
                      background: previewColor
                    }}
                  />
                </span>
              </div>
              <div className="point-size-row">
                <input
                  type="range"
                  min={MIN_SIZE}
                  max={MAX_SIZE}
                  step={1}
                  value={selectedSize ?? dotSize}
                  title="Taille du point"
                  aria-label="Taille du point"
                  onChange={(event) => applyToSelected(clampSize(Number(event.target.value)))}
                />
              </div>
            </fieldset>,
            panelSlotEl
          )
        : null}
    </>
  )
}
