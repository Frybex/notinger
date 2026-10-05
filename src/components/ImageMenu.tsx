import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import Icon from './Icon'
import {
  addPdfDoc,
  importPdfFile,
  makePdfDocId,
  persistPdfDoc,
  renderPdfPageToDataUrl
} from '../lib/pdf'

type ImageMenuProps = {
  hostRef: { current: HTMLElement | null }
  apiRef: { current: ExcalidrawImperativeAPI | null }
  /** API publiée quand Excalidraw est prêt (peut arriver après le montage). */
  api: ExcalidrawImperativeAPI | null
  renderKey: number
  onError: (message: string) => void
}

type PendingPdf = {
  docId: string
  page: number
  total: number
  name: string
  dataUrl: string
  pxW: number
  pxH: number
}

const PLACE_WIDTH = 640

function findImageTool(host: HTMLElement | null): HTMLElement | null {
  if (!host) return null
  const img = host.querySelector('[data-testid="toolbar-image"]')
  if (!img) return null
  const tool = img.closest('label.ToolIcon, button.ToolIcon, .ToolIcon')
  return (tool ?? img) as HTMLElement
}

export default function ImageMenu({ hostRef, apiRef, api, renderKey, onError }: ImageMenuProps) {
  const pendingRef = useRef<PendingPdf | null>(null)
  const placingRef = useRef(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  const [slotEl, setSlotEl] = useState<HTMLSpanElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  const [imgActive, setImgActive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [placing, setPlacing] = useState(false)

  useEffect(() => {
    placingRef.current = placing
  }, [placing])

  // Bouton unique à la place de l'outil image natif (masqué en CSS).
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
      const anchor = findImageTool(host)
      if (anchor?.parentElement) {
        slot = document.createElement('span')
        slot.className = 'imgmenu-slot'
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

  // Suit l'outil image natif pour surligner le bouton.
  useEffect(() => {
    const instance = api
    if (!instance) return
    const sync = () => {
      try {
        setImgActive(instance.getAppState().activeTool?.type === 'image')
      } catch {
        /* ignore */
      }
    }
    sync()
    const off = instance.onChange(() => sync())
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, renderKey])

  // Ferme le menu au clic ailleurs / Échap.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest?.('.imgmenu, .imgmenu-tool')) return
      setMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [menuOpen])

  const openMenu = useCallback(() => {
    if (placingRef.current) {
      pendingRef.current = null
      setPlacing(false)
      return
    }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) setMenuPos({ x: Math.max(8, rect.left - 40), y: rect.bottom + 8 })
    setMenuOpen((value) => !value)
  }, [])

  const chooseImage = useCallback(() => {
    setMenuOpen(false)
    pendingRef.current = null
    setPlacing(false)
    try {
      apiRef.current?.setActiveTool({ type: 'image' })
    } catch (cause) {
      onError(`Outil image impossible : ${String(cause)}`)
    }
  }, [apiRef, onError])

  const clientToScene = useCallback(
    (clientX: number, clientY: number) => {
      const instance = apiRef.current
      const host = hostRef.current
      if (!instance || !host) return null
      const appState = instance.getAppState()
      const zoom = appState.zoom?.value ?? 1
      const scrollX = appState.scrollX ?? 0
      const scrollY = appState.scrollY ?? 0
      const surface =
        host.querySelector('.excalidraw__canvas') ?? host.querySelector('.excalidraw') ?? host
      const rect = surface.getBoundingClientRect()
      return {
        x: (clientX - rect.left) / zoom - scrollX,
        y: (clientY - rect.top) / zoom - scrollY
      }
    },
    [apiRef, hostRef]
  )

  const insertPdfAt = useCallback(
    (pending: PendingPdf, x: number, y: number, w: number, h: number) => {
      const instance = apiRef.current
      if (!instance) {
        onError('Plan de travail non prêt.')
        return
      }
      const fileId = `pdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      instance.addFiles([
        {
          mimeType: 'image/png',
          id: fileId as never,
          dataURL: pending.dataUrl as never,
          created: Date.now()
        }
      ])
      const elements = instance.getSceneElements()
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
      const nonce = () => Math.floor(Math.random() * 2 ** 31)
      instance.updateScene({
        elements: [
          ...elements,
          {
            id,
            type: 'image',
            x,
            y,
            width: Math.max(1, Math.round(w)),
            height: Math.max(1, Math.round(h)),
            angle: 0,
            strokeColor: 'transparent',
            backgroundColor: 'transparent',
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
            fileId,
            status: 'saved',
            scale: [1, 1],
            crop: null,
            customData: {
              notingerPdf: { docId: pending.docId, page: pending.page, total: pending.total, name: pending.name }
            },
            seed: nonce(),
            version: 1,
            versionNonce: nonce(),
            isDeleted: false,
            updated: Date.now()
          } as never
        ]
      })
    },
    [apiRef, onError]
  )

  const choosePdf = useCallback(async () => {
    setMenuOpen(false)
    if (busy) return
    setBusy(true)
    try {
      const loaded = await importPdfFile()
      if (!loaded) return
      const docId = makePdfDocId()
      addPdfDoc(docId, {
        doc: loaded.doc,
        numPages: loaded.numPages,
        fileName: loaded.fileName,
        destroy: loaded.destroy
      })
      // Copie en bibliothèque : le PDF reste lié au schéma après un
      // redémarrage, même si le fichier d'origine bouge.
      try {
        await persistPdfDoc(docId, loaded.path)
      } catch (cause) {
        onError(`PDF non enregistré dans la bibliothèque : ${String(cause)}`)
      }
      const first = await renderPdfPageToDataUrl(loaded.doc, 1, 1400)
      pendingRef.current = {
        docId,
        page: 1,
        total: loaded.numPages,
        name: loaded.fileName,
        dataUrl: first.dataUrl,
        pxW: first.w,
        pxH: first.h
      }
      setPlacing(true)
    } catch (cause) {
      onError(`Import du PDF impossible : ${String(cause)}`)
    } finally {
      setBusy(false)
    }
  }, [busy, onError])

  // Placement direct : clic = taille par défaut, glisser = rectangle. Échap annule.
  useEffect(() => {
    if (!placing) return
    const host = hostRef.current
    if (!host) {
      setPlacing(false)
      return
    }
    host.classList.add('pdf-placing')
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        pendingRef.current = null
        setPlacing(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    let moveClient: { x: number; y: number } | null = null
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      if ((event.target as HTMLElement).closest('.imgmenu, .imgmenu-tool, .pdfov-bar')) return
      // Un autre outil exclusif (Point) a la main : lui rend le clic.
      try {
        if (apiRef.current?.getAppState()?.activeTool?.type === 'custom') return
      } catch {
        /* ignore */
      }
      if (
        !(event.target instanceof HTMLCanvasElement) ||
        !event.target.closest('.excalidraw')
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const startScene = clientToScene(event.clientX, event.clientY)
      if (!startScene) {
        setPlacing(false)
        return
      }
      moveClient = { x: event.clientX, y: event.clientY }
      const onMove = (moveEvent: PointerEvent) => {
        moveClient = { x: moveEvent.clientX, y: moveEvent.clientY }
      }
      const onUp = (upEvent: PointerEvent) => {
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
        const pending = pendingRef.current
        pendingRef.current = null
        setPlacing(false)
        if (!pending) return
        const endClient = moveClient ?? { x: upEvent.clientX, y: upEvent.clientY }
        const endScene = clientToScene(endClient.x, endClient.y)
        if (!endScene) return
        const aspect = pending.pxH / Math.max(1, pending.pxW)
        const draggedW = Math.abs(endScene.x - startScene.x)
        if (Math.hypot(endClient.x - event.clientX, endClient.y - event.clientY) < 6 || draggedW < 10) {
          const w = Math.min(PLACE_WIDTH, pending.pxW)
          const h = w * aspect
          insertPdfAt(pending, startScene.x - w / 2, startScene.y - h / 2, w, h)
        } else {
          const w = draggedW
          const h = draggedW * aspect
          insertPdfAt(
            pending,
            Math.min(startScene.x, endScene.x),
            endScene.y >= startScene.y ? startScene.y : startScene.y - h,
            w,
            h
          )
        }
      }
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
    }
    host.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      host.classList.remove('pdf-placing')
      window.removeEventListener('keydown', onKey, true)
      host.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [placing, clientToScene, hostRef, apiRef, insertPdfAt])

  return (
    <>
      {slotEl
        ? createPortal(
            <button
              ref={buttonRef}
              type="button"
              className={`ToolIcon imgmenu-tool${menuOpen || imgActive || placing ? ' imgmenu-active' : ''}`}
              title="Insérer une image ou un PDF"
              onClick={openMenu}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="ToolIcon__icon" aria-hidden="true">
                <Icon name="image" size={16} />
                <span className="ToolIcon__keybinding">9</span>
              </div>
            </button>,
            slotEl
          )
        : null}
      {menuOpen ? (
        <div className="context-menu imgmenu" style={{ top: menuPos.y, left: menuPos.x }}>
          <span className="context-title">Insérer</span>
          <button type="button" onClick={chooseImage} disabled={busy}>
            <Icon name="image" size={13} />
            Insérer une image
          </button>
          <button type="button" onClick={() => void choosePdf()} disabled={busy}>
            <Icon name="fileText" size={13} />
            {busy ? 'Chargement…' : 'Importer un PDF'}
          </button>
        </div>
      ) : null}
      {placing ? (
        <div className="pdf-hint" role="status" onPointerDown={(event) => event.stopPropagation()}>
          <Icon name="fileText" size={14} />
          Cliquez ou tracez un rectangle pour poser le PDF — Échap pour annuler
        </div>
      ) : null}
    </>
  )
}
