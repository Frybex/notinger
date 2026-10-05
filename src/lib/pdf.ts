import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { api } from './api'

let workerReady = false

function ensureWorker(): void {
  if (!workerReady) {
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
    workerReady = true
  }
}

export type LoadedPdf = {
  doc: PDFDocumentProxy
  numPages: number
  fileName: string
  /** Chemin du fichier choisi dans le dialogue (pour la copie en bibliothèque). */
  path: string
  destroy: () => Promise<void>
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/** Dialogue système → charge le PDF en mémoire (reste disponible pour naviguer). */
export async function importPdfFile(): Promise<LoadedPdf | null> {
  const selection = (await openDialog({
    multiple: false,
    title: 'Importer un PDF',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })) as string | string[] | null
  const path = Array.isArray(selection) ? selection[0] : selection
  if (!path) return null
  const files = await api.readImports([path])
  if (files.length === 0) return null
  ensureWorker()
  const bytes = base64ToBytes(files[0].data)
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  const loadingTask = pdfjs.getDocument({ data: copy })
  const doc = await loadingTask.promise
  return {
    doc,
    numPages: doc.numPages,
    fileName: files[0].name,
    path,
    destroy: () => loadingTask.destroy()
  }
}

/** Rend une page en PNG (dataURL) à la largeur voulue, fond blanc. */
export async function renderPdfPageToDataUrl(
  doc: PDFDocumentProxy,
  pageNum: number,
  targetWidthPx: number
): Promise<{ dataUrl: string; w: number; h: number }> {
  const pdfPage = await doc.getPage(pageNum)
  const base = pdfPage.getViewport({ scale: 1 })
  if (base.width === 0 || base.height === 0) throw new Error('page vide')
  const viewport = pdfPage.getViewport({ scale: targetWidthPx / base.width })
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  await pdfPage.render({ canvas, viewport, background: '#ffffff' }).promise
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((result) => resolve(result), 'image/png')
  )
  if (!blob) throw new Error('export PNG impossible')
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
  return { dataUrl, w: canvas.width, h: canvas.height }
}

// Registre des PDF chargés : les objets du plan s'y réfèrent par docId
// pour tourner les pages sans recharger le fichier.
export type PdfDocEntry = {
  doc: PDFDocumentProxy
  numPages: number
  fileName: string
  destroy: () => Promise<void>
}

const registry = new Map<string, PdfDocEntry>()
const pendingLoads = new Map<string, Promise<PdfDocEntry | null>>()

export function makePdfDocId(): string {
  return `pdfdoc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function addPdfDoc(id: string, entry: PdfDocEntry): void {
  registry.set(id, entry)
}

export function getPdfDoc(id: string): PdfDocEntry | undefined {
  return registry.get(id)
}

/** Copie le PDF choisi dans la bibliothèque pour qu'il survive au redémarrage. */
export async function persistPdfDoc(docId: string, sourcePath: string): Promise<void> {
  await api.savePdf(docId, sourcePath)
}

/**
 * Retrouve un PDF déjà chargé, sinon le recharge depuis la copie en
 * bibliothèque. Renvoie null si le fichier n'a jamais été enregistré
 * (schéma importé d'ailleurs) : l'interface propose alors de le lier.
 */
export function ensurePdfDoc(id: string, fileName?: string): Promise<PdfDocEntry | null> {
  const existing = registry.get(id)
  if (existing) return Promise.resolve(existing)
  const pending = pendingLoads.get(id)
  if (pending) return pending
  const promise = (async () => {
    try {
      const data = await api.readPdf(id)
      const bytes = base64ToBytes(data)
      const copy = new Uint8Array(bytes.length)
      copy.set(bytes)
      ensureWorker()
      const loadingTask = pdfjs.getDocument({ data: copy })
      const doc = await loadingTask.promise
      const entry: PdfDocEntry = {
        doc,
        numPages: doc.numPages,
        fileName: fileName ?? '',
        destroy: () => loadingTask.destroy()
      }
      registry.set(id, entry)
      return entry
    } catch {
      return null
    } finally {
      pendingLoads.delete(id)
    }
  })()
  pendingLoads.set(id, promise)
  return promise
}
