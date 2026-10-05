import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import Icon from './Icon'
import {
  addPdfDoc,
  ensurePdfDoc,
  getPdfDoc,
  importPdfFile,
  makePdfDocId,
  persistPdfDoc,
  renderPdfPageToDataUrl
} from '../lib/pdf'

type PdfOverlayProps = {
  hostRef: { current: HTMLElement | null }
  apiRef: { current: ExcalidrawImperativeAPI | null }
  /** API publiée quand Excalidraw est prêt (peut arriver après le montage). */
  api: ExcalidrawImperativeAPI | null
  renderKey: number
  onError: (message: string) => void
}

export type PdfMeta = {
  docId: string
  page: number
  total: number
  name: string
}

function pdfMetaOf(el: ExcalidrawElement): PdfMeta | null {
  if (el.type !== 'image' || el.isDeleted) return null
  const meta = (el as unknown as { customData?: { notingerPdf?: PdfMeta } }).customData
    ?.notingerPdf
  if (!meta || typeof meta.docId !== 'string') return null
  return meta
}

type View = {
  scrollX: number
  scrollY: number
  zoom: number
  selected: Set<string>
}

export default function PdfOverlay({ hostRef, apiRef, api, renderKey, onError }: PdfOverlayProps) {
  const pdfElsRef = useRef<ExcalidrawElement[]>([])
  const viewRef = useRef<View>({ scrollX: 0, scrollY: 0, zoom: 1, selected: new Set() })

  const [tick, setTick] = useState(0)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [turningIds, setTurningIds] = useState<readonly string[]>([])
  const [loadingDocs, setLoadingDocs] = useState<ReadonlySet<string>>(() => new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const attemptedDocsRef = useRef<Set<string>>(new Set())

  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  const snapshot = useCallback(
    (elements: readonly ExcalidrawElement[], selected: Set<string>) => {
      pdfElsRef.current = elements.filter((el) => pdfMetaOf(el) !== null)
      viewRef.current.selected = selected
      setTick((value) => value + 1)
    },
    []
  )

  useEffect(() => {
    const instance = api
    const host = hostRef.current
    if (!instance || !host) return
    const readSelected = (): Set<string> => {
      try {
        const ids = instance.getAppState().selectedElementIds as Record<string, boolean> | undefined
        return new Set(Object.keys(ids ?? {}))
      } catch {
        return new Set()
      }
    }
    const pull = () => {
      try {
        const elements = instance.getSceneElements()
        const appState = instance.getAppState()
        viewRef.current.scrollX = appState.scrollX ?? 0
        viewRef.current.scrollY = appState.scrollY ?? 0
        viewRef.current.zoom = appState.zoom?.value || 1
        snapshot(elements, readSelected())
      } catch {
        /* ignore */
      }
    }
    pull()
    const offChange = instance.onChange((elements) => {
      try {
        const appState = instance.getAppState()
        viewRef.current.scrollX = appState.scrollX ?? 0
        viewRef.current.scrollY = appState.scrollY ?? 0
        viewRef.current.zoom = appState.zoom?.value || 1
        snapshot(elements, readSelected())
      } catch {
        /* ignore */
      }
    })
    const offScroll = instance.onScrollChange((scrollX, scrollY, zoom) => {
      viewRef.current.scrollX = scrollX
      viewRef.current.scrollY = scrollY
      viewRef.current.zoom = zoom.value || 1
      setTick((value) => value + 1)
    })
    const onResize = () => setTick((value) => value + 1)
    window.addEventListener('resize', onResize)
    return () => {
      offChange()
      offScroll()
      window.removeEventListener('resize', onResize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, renderKey])

  // PDF enregistrés dans la bibliothèque : les rattacher automatiquement au
  // chargement du schéma (plus besoin de « Lier » après un redémarrage).
  useEffect(() => {
    const missing = new Map<string, string>()
    for (const el of pdfElsRef.current) {
      const meta = pdfMetaOf(el)
      if (!meta || getPdfDoc(meta.docId) || attemptedDocsRef.current.has(meta.docId)) continue
      missing.set(meta.docId, meta.name)
    }
    if (missing.size === 0) return
    for (const id of missing.keys()) attemptedDocsRef.current.add(id)
    setLoadingDocs((previous) => {
      const next = new Set(previous)
      for (const id of missing.keys()) next.add(id)
      return next
    })
    for (const [id, name] of missing) {
      void ensurePdfDoc(id, name).then((entry) => {
        setLoadingDocs((previous) => {
          if (!previous.has(id)) return previous
          const next = new Set(previous)
          next.delete(id)
          return next
        })
        if (entry) setTick((value) => value + 1)
      })
    }
  }, [tick, renderKey])

  // Survol : retrouve l'objet PDF sous le curseur (le plus au-dessus).
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onMove = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest?.('.pdfov-bar')) return
      if (!(target instanceof HTMLCanvasElement) || !target.closest('.excalidraw')) return
      const instance = apiRef.current
      if (!instance) return
      let zoom = 1
      let scrollX = 0
      let scrollY = 0
      try {
        const appState = instance.getAppState()
        zoom = appState.zoom?.value || 1
        scrollX = appState.scrollX ?? 0
        scrollY = appState.scrollY ?? 0
      } catch {
        return
      }
      const surface = host.querySelector('.excalidraw__canvas') ?? host
      const rect = surface.getBoundingClientRect()
      const sx = (event.clientX - rect.left) / zoom - scrollX
      const sy = (event.clientY - rect.top) / zoom - scrollY
      const els = pdfElsRef.current
      let found: string | null = null
      for (let index = els.length - 1; index >= 0; index -= 1) {
        const el = els[index]
        if (sx >= el.x && sx <= el.x + el.width && sy >= el.y && sy <= el.y + el.height) {
          found = el.id
          break
        }
      }
      setHoverId((previous) => (previous === found ? previous : found))
    }
    const onLeave = () => setHoverId(null)
    host.addEventListener('pointermove', onMove)
    host.addEventListener('pointerleave', onLeave)
    return () => {
      host.removeEventListener('pointermove', onMove)
      host.removeEventListener('pointerleave', onLeave)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey])

  const extractPage = useCallback(
    (el: ExcalidrawElement) => {
      const instance = apiRef.current
      if (!instance) return
      const nonce = () => Math.floor(Math.random() * 2 ** 31)
      const id = `pdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const elements = instance.getSceneElements()
      const copy = {
        ...el,
        id,
        x: el.x + el.width + 40,
        y: el.y,
        // Image simple : plus de lien vers le PDF, la page reste telle quelle.
        customData: undefined,
        seed: nonce(),
        version: 1,
        versionNonce: nonce(),
        updated: Date.now()
      }
      instance.updateScene({
        elements: [...elements, copy as never],
        appState: { selectedElementIds: { [id]: true } }
      })
      try {
        instance.setActiveTool({ type: 'selection' })
      } catch {
        /* ignore */
      }
    },
    [apiRef]
  )

  const turnTo = useCallback(
    async (el: ExcalidrawElement, page: number) => {
      const meta = pdfMetaOf(el)
      if (!meta || turningIds.includes(el.id)) return
      const entry = getPdfDoc(meta.docId)
      if (!entry) return
      const next = Math.min(Math.max(1, page), entry.numPages)
      if (next === meta.page) return
      setTurningIds((previous) => [...previous, el.id])
      try {
        const targetW = Math.min(2200, Math.max(900, Math.round(el.width * 1.5)))
        const shot = await renderPdfPageToDataUrl(entry.doc, next, targetW)
        const instance = apiRef.current
        if (!instance) return
        const fileId = `pdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        instance.addFiles([
          {
            mimeType: 'image/png',
            id: fileId as never,
            dataURL: shot.dataUrl as never,
            created: Date.now()
          }
        ])
        const height = Math.max(1, Math.round(el.width * (shot.h / Math.max(1, shot.w))))
        const elements = instance.getSceneElements()
        instance.updateScene({
          elements: elements.map((item) =>
            item.id === el.id
              ? ({
                  ...item,
                  fileId,
                  height,
                  customData: {
                    notingerPdf: { ...meta, page: next, total: entry.numPages }
                  }
                } as never)
              : item
          )
        })
      } catch (cause) {
        onError(`Page impossible : ${String(cause)}`)
      } finally {
        setTurningIds((previous) => previous.filter((id) => id !== el.id))
      }
    },
    [apiRef, onError, turningIds]
  )

  const linkOrphan = useCallback(
    async (el: ExcalidrawElement) => {
      const meta = pdfMetaOf(el)
      if (!meta || turningIds.includes(el.id)) return
      setTurningIds((previous) => [...previous, el.id])
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
        // Enregistré aussi en bibliothèque : la liaison tiendra au prochain
        // démarrage.
        try {
          await persistPdfDoc(docId, loaded.path)
        } catch (cause) {
          onError(`PDF non enregistré dans la bibliothèque : ${String(cause)}`)
        }
        const targetW = Math.min(2200, Math.max(900, Math.round(el.width * 1.5)))
        const shot = await renderPdfPageToDataUrl(loaded.doc, 1, targetW)
        const instance = apiRef.current
        if (!instance) return
        const fileId = `pdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        instance.addFiles([
          {
            mimeType: 'image/png',
            id: fileId as never,
            dataURL: shot.dataUrl as never,
            created: Date.now()
          }
        ])
        const height = Math.max(1, Math.round(el.width * (shot.h / Math.max(1, shot.w))))
        const elements = instance.getSceneElements()
        instance.updateScene({
          elements: elements.map((item) =>
            item.id === el.id
              ? ({
                  ...item,
                  fileId,
                  height,
                  customData: {
                    notingerPdf: { docId, page: 1, total: loaded.numPages, name: loaded.fileName }
                  }
                } as never)
              : item
          )
        })
      } catch (cause) {
        onError(`Liaison impossible : ${String(cause)}`)
      } finally {
        setTurningIds((previous) => previous.filter((id) => id !== el.id))
      }
    },
    [apiRef, onError, turningIds]
  )

  const commitDraft = useCallback(
    (el: ExcalidrawElement) => {
      const parsed = Number.parseInt(draft, 10)
      setEditingId(null)
      if (Number.isFinite(parsed)) void turnTo(el, parsed)
    },
    [draft, turnTo]
  )

  const host = hostRef.current
  void tick
  if (!host) return null
  const hostRect = host.getBoundingClientRect()
  const surface = host.querySelector('.excalidraw__canvas') ?? host
  const srect = surface.getBoundingClientRect()
  const { scrollX, scrollY, zoom } = viewRef.current
  const selected = viewRef.current.selected

  const bars: Array<{
    id: string
    el: ExcalidrawElement
    meta: PdfMeta
    orphan: boolean
    loading: boolean
    left: number
    top: number
  }> = []
  for (const el of pdfElsRef.current) {
    const meta = pdfMetaOf(el)
    if (!meta) continue
    const sx = (el.x + scrollX) * zoom + (srect.left - hostRect.left)
    const sy = (el.y + scrollY) * zoom + (srect.top - hostRect.top)
    const w = el.width * zoom
    const h = el.height * zoom
    if (sx > hostRect.width || sy > hostRect.height || sx + w < 0 || sy + h < 0) continue
    const visible =
      hoverId === el.id || selected.has(el.id) || turningIds.includes(el.id) || editingId === el.id
    if (!visible) continue
    let top = sy + h + 6
    if (top + 36 > hostRect.height) top = Math.max(8, sy - 42)
    bars.push({
      id: el.id,
      el,
      meta,
      orphan: !getPdfDoc(meta.docId),
      loading: loadingDocs.has(meta.docId),
      left: Math.min(Math.max(8, sx + w / 2 - 80), Math.max(8, hostRect.width - 170)),
      top
    })
  }
  if (bars.length === 0) return null

  return (
    <div className="pdfov-layer">
      {bars.map(({ id, el, meta, orphan, loading, left, top }) => (
        <div
          key={id}
          className="pdfov-bar"
          style={{ left, top }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {orphan ? (
            loading ? (
              <>
                <span className="pdfov-name" title={meta.name}>
                  {meta.name}
                </span>
                <span className="pdfov-loading">Chargement…</span>
              </>
            ) : (
              <>
                <span className="pdfov-name" title={meta.name}>
                  {meta.name}
                </span>
                <button
                  type="button"
                  className="pdfov-link"
                  onClick={() => void linkOrphan(el)}
                  title="Recharger le fichier PDF pour naviguer"
                >
                  <Icon name="folder" size={13} />
                  Lier
                </button>
              </>
            )
          ) : (
            <>
              <button
                type="button"
                onClick={() => void turnTo(el, meta.page - 1)}
                disabled={meta.page <= 1 || turningIds.includes(id)}
                title="Page précédente"
              >
                <Icon name="chevronLeft" size={15} />
              </button>
              {editingId === id ? (
                <input
                  ref={inputRef}
                  className="pdfov-count-input"
                  value={draft}
                  inputMode="numeric"
                  onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ''))}
                  onBlur={() => commitDraft(el)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitDraft(el)
                    if (event.key === 'Escape') setEditingId(null)
                    event.stopPropagation()
                  }}
                  onClick={(event) => event.stopPropagation()}
                  spellCheck={false}
                />
              ) : (
                <button
                  type="button"
                  className="pdfov-count"
                  onDoubleClick={() => {
                    setDraft(String(meta.page))
                    setEditingId(id)
                  }}
                  title="Double-cliquer pour saisir un numéro de page"
                >
                  {meta.page} / {meta.total}
                </button>
              )}
              <button
                type="button"
                onClick={() => void turnTo(el, meta.page + 1)}
                disabled={meta.page >= meta.total || turningIds.includes(id)}
                title="Page suivante"
              >
                <Icon name="chevronRight" size={15} />
              </button>
              <button
                type="button"
                className="pdfov-extract"
                onClick={() => extractPage(el)}
                title="Extraire cette page en image (copie libre, à dessiner)"
              >
                <Icon name="copy" size={13} />
                Extraire
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
