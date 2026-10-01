import { useCallback, useEffect, useRef, useState } from 'react'
import { Excalidraw, exportToBlob, loadFromBlob, serializeAsJSON } from '@excalidraw/excalidraw'
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState
} from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement, NonDeleted } from '@excalidraw/excalidraw/element/types'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { confirm, open as openDialog } from '@tauri-apps/plugin-dialog'
import Sidebar from './components/Sidebar'
import Icon from './components/Icon'
import { attachWheelZoom } from './lib/wheelZoom'
import { api, type DrawingMeta, type SaveState } from './lib/api'
import '@excalidraw/excalidraw/index.css'

type Scene = {
  elements: readonly ExcalidrawElement[]
  appState: Partial<AppState>
  files: BinaryFiles
}

type ThemeMode = 'system' | 'light' | 'dark'

function readThemeMode(): ThemeMode {
  const stored = localStorage.getItem('notinger.theme')
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export default function App() {
  const [metas, setMetas] = useState<DrawingMeta[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [scene, setScene] = useState<ExcalidrawInitialDataState | null>(null)
  const [renderKey, setRenderKey] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode)
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>('light')
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem('notinger.sidebar') !== 'closed'
  )
  const [libraryDir, setLibraryDir] = useState('')
  const [error, setError] = useState<string | null>(null)

  const theme = themeMode === 'system' ? systemTheme : themeMode

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const canvasRef = useRef<HTMLElement | null>(null)
  const liveRef = useRef<Scene | null>(null)
  const currentIdRef = useRef<string | null>(null)
  const metasRef = useRef<DrawingMeta[]>([])
  const systemThemeRef = useRef<'light' | 'dark'>('light')
  const dirtyRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const lastThumbRef = useRef(0)

  useEffect(() => {
    metasRef.current = metas
  }, [metas])

  useEffect(() => {
    const host = canvasRef.current
    if (!host) return
    return attachWheelZoom(host)
  }, [])

  useEffect(() => {
    systemThemeRef.current = systemTheme
  }, [systemTheme])

  useEffect(() => {
    localStorage.setItem('notinger.theme', themeMode)
  }, [themeMode])

  useEffect(() => {
    localStorage.setItem('notinger.sidebar', sidebarOpen ? 'open' : 'closed')
  }, [sidebarOpen])

  const toggleTheme = useCallback(() => {
    setThemeMode((previous) => {
      const current = previous === 'system' ? systemThemeRef.current : previous
      return current === 'dark' ? 'light' : 'dark'
    })
  }, [])

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => !open)
  }, [])

  const makeThumbnail = useCallback(async (id: string, current: Scene) => {
    try {
      const elements = current.elements.filter(
        (element) => !element.isDeleted
      ) as NonDeleted<ExcalidrawElement>[]
      if (elements.length === 0) return
      const blob = await exportToBlob({
        elements,
        appState: {
          ...current.appState,
          exportBackground: true,
          viewBackgroundColor: current.appState.viewBackgroundColor ?? '#ffffff'
        },
        files: current.files,
        exportPadding: 16,
        getDimensions: (width: number, height: number) => ({
          width: 400,
          height: Math.max(1, Math.round((400 * height) / Math.max(1, width)))
        })
      })
      const dataUrl = await blobToDataUrl(blob)
      await api.saveThumbnail(id, dataUrl)
      setMetas((previous) =>
        previous.map((meta) => (meta.id === id ? { ...meta, thumbnail: dataUrl } : meta))
      )
    } catch {
      setSaveState('idle')
    }
  }, [])

  const doSave = useCallback(
    async (options: { force?: boolean; thumb?: boolean } = {}) => {
      const id = currentIdRef.current
      const current = liveRef.current
      if (!id || !current) return
      if (!dirtyRef.current && !options.force) return
      dirtyRef.current = false
      setSaveState('saving')
      try {
        const json = serializeAsJSON(current.elements, current.appState, current.files, 'local')
        await api.writeDrawing(id, json)
        setSaveState('saved')
        setMetas((previous) =>
          previous.map((meta) => (meta.id === id ? { ...meta, updatedAt: Date.now() } : meta))
        )
        if (options.thumb || Date.now() - lastThumbRef.current > 12000) {
          lastThumbRef.current = Date.now()
          void makeThumbnail(id, current)
        }
      } catch (cause) {
        dirtyRef.current = true
        setSaveState('error')
        setError(`Enregistrement impossible : ${String(cause)}`)
      }
    },
    [makeThumbnail]
  )

  const handleChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      liveRef.current = { elements, appState, files }
      dirtyRef.current = true
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        void doSave()
      }, 600)
    },
    [doSave]
  )

  const openDrawing = useCallback(
    async (id: string, options: { flush?: boolean } = {}) => {
      if (id === currentIdRef.current) return
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (options.flush !== false) await doSave({ thumb: true })
      setLoading(true)
      try {
        const raw = await api.readDrawing(id)
        const parsed = JSON.parse(raw)
        liveRef.current = null
        dirtyRef.current = false
        currentIdRef.current = id
        setCurrentId(id)
        setScene({
          elements: parsed.elements ?? [],
          appState: parsed.appState ?? {},
          files: parsed.files ?? {},
          scrollToContent: true
        } as ExcalidrawInitialDataState)
        setRenderKey((key) => key + 1)
        setSaveState('idle')
        setError(null)
      } catch (cause) {
        setError(`Ouverture impossible : ${String(cause)}`)
      } finally {
        setLoading(false)
      }
    },
    [doSave]
  )

  const refresh = useCallback(async () => {
    setMetas(await api.listDrawings())
  }, [])

  const openFromSystem = useCallback(
    async (id: string) => {
      await openDrawing(id)
      await refresh()
    },
    [openDrawing, refresh]
  )

  const createDrawing = useCallback(
    async (name?: string) => {
      try {
        const meta = await api.createDrawing(name)
        setMetas((previous) => [meta, ...previous.filter((item) => item.id !== meta.id)])
        await openDrawing(meta.id)
      } catch (cause) {
        setError(`Création impossible : ${String(cause)}`)
      }
    },
    [openDrawing]
  )

  const renameDrawing = useCallback(
    async (id: string, newName: string) => {
      try {
        const meta = await api.renameDrawing(id, newName)
        if (meta.id !== id) {
          setMetas((previous) =>
            previous
              .map((item) => (item.id === id ? meta : item))
              .sort((a, b) => b.updatedAt - a.updatedAt)
          )
          if (currentIdRef.current === id) {
            currentIdRef.current = meta.id
            setCurrentId(meta.id)
          }
        }
      } catch (cause) {
        setError(`Renommage impossible : ${String(cause)}`)
      }
    },
    []
  )

  const duplicateDrawing = useCallback(
    async (id: string) => {
      try {
        const meta = await api.duplicateDrawing(id)
        setMetas((previous) => [meta, ...previous])
        await openDrawing(meta.id)
      } catch (cause) {
        setError(`Duplication impossible : ${String(cause)}`)
      }
    },
    [openDrawing]
  )

  const deleteDrawing = useCallback(
    async (id: string) => {
      const accepted = await confirm(`Placer « ${id} » dans la corbeille ?`, {
        title: 'Supprimer le schéma',
        kind: 'warning',
        okLabel: 'Corbeille',
        cancelLabel: 'Annuler'
      })
      if (!accepted) return
      try {
        await api.deleteDrawing(id)
        const remaining = metasRef.current.filter((meta) => meta.id !== id)
        setMetas(remaining)
        if (currentIdRef.current === id) {
          if (remaining.length > 0) {
            await openDrawing(remaining[0].id, { flush: false })
          } else {
            currentIdRef.current = null
            liveRef.current = null
            dirtyRef.current = false
            setCurrentId(null)
            setScene(null)
          }
        }
      } catch (cause) {
        setError(`Suppression impossible : ${String(cause)}`)
      }
    },
    [openDrawing]
  )

  const importFiles = useCallback(async () => {
    try {
      const selection = (await openDialog({
        multiple: true,
        title: 'Importer des schémas',
        filters: [{ name: 'Excalidraw', extensions: ['excalidraw', 'json', 'png'] }]
      })) as string[] | null
      if (!selection || selection.length === 0) return
      const files = await api.readImports(selection)
      let lastId: string | null = null
      for (const file of files) {
        try {
          const bytes = base64ToBytes(file.data)
          let restored: {
            elements?: readonly ExcalidrawElement[]
            appState?: Partial<AppState>
            files?: BinaryFiles
          } = {}
          if (file.name.toLowerCase().endsWith('.png')) {
            const result = await loadFromBlob(new Blob([bytes], { type: 'image/png' }), null, null)
            restored = { elements: result.elements, appState: result.appState, files: result.files }
          } else {
            const parsed = JSON.parse(new TextDecoder().decode(bytes))
            if (parsed?.type !== 'excalidraw') throw new Error('format inconnu')
            restored = {
              elements: parsed.elements ?? [],
              appState: parsed.appState ?? {},
              files: parsed.files ?? {}
            }
          }
          const baseName = file.name.replace(/\.(excalidraw|json|png)$/i, '')
          const meta = await api.createDrawing(baseName)
          await api.writeDrawing(
            meta.id,
            JSON.stringify({
              type: 'excalidraw',
              version: 2,
              source: 'notinger',
              elements: restored.elements ?? [],
              appState: restored.appState ?? {},
              files: restored.files ?? {}
            })
          )
          setMetas((previous) => [meta, ...previous.filter((item) => item.id !== meta.id)])
          lastId = meta.id
        } catch (cause) {
          setError(`Import impossible pour « ${file.name} » : ${String(cause)}`)
        }
      }
      await refresh()
      if (lastId) await openDrawing(lastId)
    } catch (cause) {
      setError(`Import impossible : ${String(cause)}`)
    }
  }, [openDrawing, refresh])

  useEffect(() => {
    let cancelled = false
    const unlisten = listen<string>('open-drawing', ({ payload }) => {
      void openFromSystem(payload)
    })
    void (async () => {
      try {
        const [list, info] = await Promise.all([api.listDrawings(), api.libraryInfo()])
        if (cancelled) return
        setLibraryDir(info.dir)
        setMetas(list)
        const pending = await api.frontendReady().catch(() => [] as string[])
        if (cancelled) return
        const requested = pending.length > 0 ? pending[pending.length - 1] : null
        if (requested) {
          await openFromSystem(requested)
        } else if (list.length > 0) {
          await openDrawing(list[0].id, { flush: false })
        } else {
          setLoading(false)
        }
      } catch (cause) {
        if (!cancelled) {
          setError(String(cause))
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
      void unlisten.then((unsubscribe) => unsubscribe()).catch(() => undefined)
    }
  }, [openDrawing, openFromSystem])

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    try {
      const current = getCurrentWindow()
      current
        .theme()
        .then((value) => {
          if (value) setSystemTheme(value)
        })
        .catch(() => undefined)
      current
        .onThemeChanged(({ payload }) => setSystemTheme(payload))
        .then((fn) => {
          unsubscribe = fn
        })
        .catch(() => undefined)
    } catch {
      unsubscribe = undefined
    }
    return () => {
      if (unsubscribe) unsubscribe()
    }
  }, [])

  useEffect(() => {
    const pending = listen('app://flush', async () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      await doSave({ force: true, thumb: true })
      await api.flushComplete()
    })
    return () => {
      void pending.then((unsubscribe) => unsubscribe())
    }
  }, [doSave])

  useEffect(() => {
    const onMenu = (payload: string) => {
      if (payload === 'new') void createDrawing()
      else if (payload === 'import') void importFiles()
      else if (payload === 'toggle_sidebar') toggleSidebar()
      else if (payload === 'toggle_theme') toggleTheme()
      else if (payload === 'save') {
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current)
          timerRef.current = null
        }
        void doSave({ force: true, thumb: true })
      } else if (payload === 'open_dir') void api.openLibraryDir()
    }
    const pending = listen<string>('menu', ({ payload }) => onMenu(payload))
    return () => {
      void pending.then((unsubscribe) => unsubscribe())
    }
  }, [createDrawing, doSave, importFiles, toggleSidebar, toggleTheme])

  return (
    <div className="app" data-theme={theme}>
      <main className="canvas" ref={canvasRef}>
        {scene && !loading ? (
          <Excalidraw
            key={renderKey}
            excalidrawAPI={(instance) => {
              apiRef.current = instance
            }}
            initialData={scene}
            onChange={handleChange}
            theme={theme}
            langCode="fr-FR"
            UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
          />
        ) : null}
        {loading ? (
          <div className="canvas-loading">
            <span className="spinner" />
            Chargement du schéma…
          </div>
        ) : null}
        {!loading && !scene ? (
          <div className="canvas-empty">
            <span className="empty-mark">
              <Icon name="mark" size={26} />
            </span>
            <h2>Aucun schéma ouvert</h2>
            <p>Crée un schéma ou importe un fichier .excalidraw, .json ou .png.</p>
            <div className="empty-actions">
              <button type="button" className="primary" onClick={() => void createDrawing()}>
                <Icon name="plus" size={14} />
                Nouveau schéma
              </button>
              <button type="button" className="ghost" onClick={() => void importFiles()}>
                <Icon name="import" size={14} />
                Importer un fichier
              </button>
            </div>
          </div>
        ) : null}
      </main>
      <Sidebar
        metas={metas}
        currentId={currentId}
        libraryDir={libraryDir}
        saveState={saveState}
        collapsed={!sidebarOpen}
        theme={theme}
        onToggle={toggleSidebar}
        onToggleTheme={toggleTheme}
        onSelect={(id) => void openDrawing(id)}
        onNew={() => void createDrawing()}
        onImport={() => void importFiles()}
        onRename={(id, name) => void renameDrawing(id, name)}
        onDuplicate={(id) => void duplicateDrawing(id)}
        onDelete={(id) => void deleteDrawing(id)}
        onReveal={(id) => void api.revealDrawing(id)}
        onOpenDir={() => void api.openLibraryDir()}
      />
      {error ? (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            Fermer
          </button>
        </div>
      ) : null}
    </div>
  )
}
