import { getCommonBounds } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

/** Interfaces flottantes posées sur le canevas : on leur réserve leur place. */
const CANVAS_UI_SELECTORS = [
  '.App-menu_top__left', // menu principal (coin haut gauche)
  '.App-menu',
  '.App-toolbar-container', // barre d'outils (haut, centrée)
  '.App-top-bar',
  '.layer-ui__wrapper__top-right', // actions (coin haut droit)
  '.layer-ui__wrapper__footer', // zoom, annuler/rétablir (bas)
  '.layer-ui__wrapper__footer-left',
  '.layer-ui__wrapper__footer-right',
  '.App-menu__left', // menu principal déroulé
  '.dropdown-menu',
  '[data-testid="main-menu-trigger"]',
  '.main-menu-trigger'
]

/** Marge de respiration entre le contenu cadré et l'interface flottante. */
export const FIT_GAP = 8

export type FitInsets = { top: number; right: number; bottom: number; left: number }
export type FitViewport = { insets: FitInsets; zoom: number }

type OverlayBox = { left: number; top: number; right: number; bottom: number }

/** Boîtes (coordonnées locales au canevas) des interfaces flottantes. */
export function collectOverlayBoxes(host: HTMLElement, hostRect: DOMRect): OverlayBox[] {
  const overlays: Element[] = []
  for (const selector of CANVAS_UI_SELECTORS) {
    overlays.push(...host.querySelectorAll(selector))
  }
  const app = host.parentElement
  const library = app?.querySelector(':scope > aside.sidebar')
  if (library) overlays.push(library)
  const indicator = app?.querySelector(':scope > .panel-indicator')
  if (indicator) overlays.push(indicator)
  const boxes: OverlayBox[] = []
  for (const overlay of overlays) {
    const rect = overlay.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) continue
    if (
      rect.right <= hostRect.left ||
      rect.left >= hostRect.right ||
      rect.bottom <= hostRect.top ||
      rect.top >= hostRect.bottom
    ) {
      continue
    }
    // Boîte élargie de la marge de respiration : le contenu restera à distance.
    const box = {
      left: Math.max(0, rect.left - hostRect.left - FIT_GAP),
      top: Math.max(0, rect.top - hostRect.top - FIT_GAP),
      right: Math.min(hostRect.width, rect.right - hostRect.left + FIT_GAP),
      bottom: Math.min(hostRect.height, rect.bottom - hostRect.top + FIT_GAP)
    }
    if (box.right <= box.left || box.bottom <= box.top) continue
    boxes.push(box)
  }
  return boxes
}

/**
 * Cherche la plus grande zone rectangulaire du canevas qui n'empiète sur
 * aucune interface flottante, puis renvoie le zoom maximal qui y fait tenir
 * tout le contenu (et les marges correspondantes pour le centrage).
 */
export function computeFitViewport(
  host: HTMLElement | null,
  contentWidth: number,
  contentHeight: number
): FitViewport | null {
  const fallback = { top: FIT_GAP, right: FIT_GAP, bottom: FIT_GAP, left: FIT_GAP }
  if (!host) return null
  const hostRect = host.getBoundingClientRect()
  const width = hostRect.width
  const height = hostRect.height
  if (width < 1 || height < 1) return null
  const boxes = collectOverlayBoxes(host, hostRect)
  const minX = FIT_GAP
  const maxX = width - FIT_GAP
  const minY = FIT_GAP
  const maxY = height - FIT_GAP
  const xs = new Set<number>([minX, maxX])
  const ys = new Set<number>([minY, maxY])
  for (const box of boxes) {
    xs.add(Math.min(maxX, Math.max(minX, box.left)))
    xs.add(Math.min(maxX, Math.max(minX, box.right)))
    ys.add(Math.min(maxY, Math.max(minY, box.top)))
    ys.add(Math.min(maxY, Math.max(minY, box.bottom)))
  }
  const xList = [...xs].sort((a, b) => a - b)
  const yList = [...ys].sort((a, b) => a - b)
  let best: OverlayBox | null = null
  let bestZoom = -1
  for (let i = 0; i < xList.length; i += 1) {
    for (let j = i + 1; j < xList.length; j += 1) {
      const left = xList[i]
      const right = xList[j]
      const boxWidth = right - left
      if (boxWidth < 1) continue
      for (let k = 0; k < yList.length; k += 1) {
        for (let l = k + 1; l < yList.length; l += 1) {
          const top = yList[k]
          const bottom = yList[l]
          const boxHeight = bottom - top
          if (boxHeight < 1) continue
          let blocked = false
          for (const box of boxes) {
            if (left < box.right && right > box.left && top < box.bottom && bottom > box.top) {
              blocked = true
              break
            }
          }
          if (blocked) continue
          const zoom = Math.min(boxWidth / contentWidth, boxHeight / contentHeight)
          if (zoom > bestZoom) {
            bestZoom = zoom
            best = { left, top, right, bottom }
          }
        }
      }
    }
  }
  if (!best) {
    const zoom = Math.min((width - 2 * FIT_GAP) / contentWidth, (height - 2 * FIT_GAP) / contentHeight)
    return { insets: fallback, zoom }
  }
  return {
    insets: {
      left: best.left,
      top: best.top,
      right: width - best.right,
      bottom: height - best.bottom
    },
    zoom: bestZoom
  }
}

/**
 * Recadre tout le contenu du canevas — dessins, images et pages PDF sont des
 * éléments de la scène — en zoomant le plus possible sans rien laisser passer
 * sous l'interface flottante (barre d'outils, menus, bibliothèque).
 */
export function fitContentInViewport(
  instance: ExcalidrawImperativeAPI,
  host: HTMLElement | null,
  animated = false
) {
  const elements = instance.getSceneElements()
  if (elements.length === 0) return
  const [minX, minY, maxX, maxY] = getCommonBounds(elements)
  const contentWidth = maxX - minX
  const contentHeight = maxY - minY
  if (!(contentWidth > 0) || !(contentHeight > 0)) return
  const fit = computeFitViewport(host, contentWidth, contentHeight)
  if (!fit) {
    // Canevas non mesurable : cadrage standard (sans plafond à 100 %).
    instance.scrollToContent(elements, {
      fitToViewport: true,
      animate: animated,
      ...(animated ? { duration: 250 } : {})
    })
    return
  }
  instance.scrollToContent(elements, {
    fitToViewport: true,
    // En passant le zoom calculé comme bornes min et max, Excalidraw applique
    // exactement ce cadrage : pas d'arrondi au palier de zoom, pas de plafond
    // à 100 % ni de marge systématique — le contenu remplit l'espace utile.
    minZoom: fit.zoom,
    maxZoom: fit.zoom,
    canvasOffsets: fit.insets,
    animate: animated,
    ...(animated ? { duration: 250 } : {})
  })
}
