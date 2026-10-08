import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, MouseEvent as ReactMouseEvent } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import Icon from './Icon'
import type { DrawingMeta, FolderInfo } from '../lib/api'
import type { UpdaterStatus } from '../lib/useUpdater'
import { version as appVersion } from '../../package.json'
import { revealLabel, shortcuts } from '../lib/platform'

type SidebarProps = {
  metas: DrawingMeta[]
  folders: FolderInfo[]
  currentId: string | null
  libraryDir: string
  collapsed: boolean
  theme: 'light' | 'dark'
  newFolderSignal: number
  updateStatus: UpdaterStatus
  onCheckUpdates: () => void
  onToggle: () => void
  onToggleTheme: () => void
  onSelect: (id: string) => void
  onNew: () => void
  onNewInFolder: (folder: string) => void
  onImport: () => void
  onRename: (id: string, name: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onReveal: (id: string) => void
  onCreateFolder: (name: string) => void
  onRenameFolder: (path: string, name: string) => void
  onDeleteFolder: (path: string) => void
  onRevealFolder: (path: string) => void
  onFolderColor: (path: string, color: string | null) => void
  onMoveDrawing: (id: string, folder: string) => void
}

type EditTarget = {
  kind: 'drawing' | 'folder'
  id: string
  initial: string
}

type ContextTarget = {
  kind: 'drawing' | 'folder'
  id: string
  top: number
  left: number
}

const ROOT = ''
const COLLAPSED_KEY = 'notinger.collapsedFolders'
const MENU_WIDTH = 214

const FOLDER_COLORS = [
  '#e5484d',
  '#e8890c',
  '#d5a900',
  '#46a758',
  '#12a594',
  '#3e63dd',
  '#8e4ec6',
  '#e93d82'
]

function normalize(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function formatDate(timestamp: number) {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return "à l'instant"
  if (diff < 3_600_000) return `il y a ${Math.round(diff / 60_000)} min`
  if (diff < 86_400_000) return `il y a ${Math.round(diff / 3_600_000)} h`
  const date = new Date(timestamp)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric'
  })
}

function updateCheckLabel(status: UpdaterStatus) {
  if (status === 'checking') return 'Vérification…'
  if (status === 'up-to-date') return 'À jour'
  if (status === 'downloading' || status === 'installing') return 'Téléchargement…'
  return 'Vérifier les mises à jour'
}

export default function Sidebar({
  metas,
  folders,
  currentId,
  collapsed,
  theme,
  newFolderSignal,
  updateStatus,
  onCheckUpdates,
  onToggle,
  onToggleTheme,
  onSelect,
  onNew,
  onNewInFolder,
  onImport,
  onRename,
  onDuplicate,
  onDelete,
  onReveal,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onRevealFolder,
  onFolderColor,
  onMoveDrawing
}: SidebarProps) {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<EditTarget | null>(null)
  const [draft, setDraft] = useState('')
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY)
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : []
    } catch {
      return []
    }
  })
  const [draftingFolder, setDraftingFolder] = useState(false)
  const [folderDraft, setFolderDraft] = useState('')
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextTarget | null>(null)
  const [menuView, setMenuView] = useState<'main' | 'move'>('main')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)

  const byFolder = useMemo(() => {
    const map = new Map<string, DrawingMeta[]>()
    for (const meta of metas) {
      const list = map.get(meta.folder)
      if (list) list.push(meta)
      else map.set(meta.folder, [meta])
    }
    return map
  }, [metas])

  const needle = normalize(query.trim())
  const searching = needle.length > 0
  const filtered = useMemo(() => {
    if (!needle) return metas
    return metas.filter(
      (meta) => normalize(meta.name).includes(needle) || normalize(meta.id).includes(needle)
    )
  }, [metas, needle])

  const rootDrawings = byFolder.get(ROOT) ?? []

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  useEffect(() => {
    if (draftingFolder) folderInputRef.current?.focus()
  }, [draftingFolder])

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsedFolders))
  }, [collapsedFolders])

  useEffect(() => {
    if (newFolderSignal > 0) {
      setDraftingFolder(true)
      setFolderDraft('')
    }
  }, [newFolderSignal])

  useEffect(() => {
    if (!contextMenu) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [contextMenu])

  const startRenameDrawing = (meta: DrawingMeta) => {
    setEditing({ kind: 'drawing', id: meta.id, initial: meta.name })
    setDraft(meta.name)
  }

  const startRenameFolder = (folder: FolderInfo) => {
    setEditing({ kind: 'folder', id: folder.path, initial: folder.name })
    setDraft(folder.name)
  }

  const commitEdit = () => {
    if (!editing) return
    const value = draft.trim()
    if (value && value !== editing.initial) {
      if (editing.kind === 'drawing') onRename(editing.id, value)
      else onRenameFolder(editing.id, value)
    }
    setEditing(null)
  }

  const cancelEdit = () => setEditing(null)

  const startFolderDraft = () => {
    setDraftingFolder(true)
    setFolderDraft('')
  }

  const commitFolderDraft = () => {
    const value = folderDraft.trim()
    if (value) onCreateFolder(value)
    setDraftingFolder(false)
    setFolderDraft('')
  }

  const toggleFolder = (path: string) => {
    setCollapsedFolders((previous) =>
      previous.includes(path) ? previous.filter((item) => item !== path) : [...previous, path]
    )
  }

  const expandFolder = (path: string) => {
    setCollapsedFolders((previous) => previous.filter((item) => item !== path))
  }

  const allowDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }

  const clearDrop = (event: DragEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null
    if (!next || !event.currentTarget.contains(next)) setDropTarget(null)
  }

  const handleDragStart = (event: DragEvent<HTMLDivElement>, id: string) => {
    event.dataTransfer.setData('text/plain', id)
    event.dataTransfer.effectAllowed = 'move'
    setDraggingId(id)
    setContextMenu(null)
  }

  const handleDragEnd = () => {
    setDraggingId(null)
    setDropTarget(null)
  }

  const handleDrop = (event: DragEvent<HTMLElement>, folder: string) => {
    event.preventDefault()
    event.stopPropagation()
    const id = event.dataTransfer.getData('text/plain') || draggingId
    setDraggingId(null)
    setDropTarget(null)
    if (!id) return
    if (folder) expandFolder(folder)
    onMoveDrawing(id, folder)
  }

  const openContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    kind: 'drawing' | 'folder',
    id: string
  ) => {
    event.preventDefault()
    event.stopPropagation()
    const maxLeft = Math.max(8, window.innerWidth - MENU_WIDTH - 8)
    const maxTop = Math.max(8, window.innerHeight - 360)
    setMenuView('main')
    setContextMenu({
      kind,
      id,
      left: Math.min(event.clientX, maxLeft),
      top: Math.min(event.clientY, maxTop)
    })
  }

  const closeContextMenu = () => {
    setMenuView('main')
    setContextMenu(null)
  }

  const contextMeta =
    contextMenu?.kind === 'drawing'
      ? metas.find((meta) => meta.id === contextMenu.id) ?? null
      : null
  const contextFolder =
    contextMenu?.kind === 'folder'
      ? folders.find((folder) => folder.path === contextMenu.id) ?? null
      : null

  const themeTitle =
    theme === 'dark' ? 'Passer en mode clair' : `Passer en mode nuit (${shortcuts.toggleTheme})`

  const renderDrawing = (meta: DrawingMeta, showFolder = false) => (
    <div
      key={meta.id}
      className={meta.id === currentId ? 'item is-active' : 'item'}
      draggable={editing?.id !== meta.id}
      onDragStart={(event) => handleDragStart(event, meta.id)}
      onDragEnd={handleDragEnd}
      onContextMenu={(event) => openContextMenu(event, 'drawing', meta.id)}
    >
      <button
        type="button"
        className="item-main"
        onClick={() => onSelect(meta.id)}
        onDoubleClick={() => startRenameDrawing(meta)}
        title={meta.id}
      >
        <span className="thumb">
          {meta.thumbnail ? (
            <img src={meta.thumbnail} alt="" draggable={false} />
          ) : (
            <span className="thumb-fallback">{meta.name.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <span className="item-text">
          {editing?.kind === 'drawing' && editing.id === meta.id ? (
            <input
              ref={inputRef}
              className="rename-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onBlur={commitEdit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitEdit()
                if (event.key === 'Escape') cancelEdit()
              }}
              spellCheck={false}
            />
          ) : (
            <span className="item-name">{meta.name}</span>
          )}
          <span className="item-date">
            {showFolder && meta.folder ? `${meta.folder} · ` : ''}
            {formatDate(meta.updatedAt)}
          </span>
        </span>
      </button>
    </div>
  )

  if (collapsed) {
    return (
      <div className="panel-indicator" data-tauri-drag-region>
        <button
          type="button"
          className="panel-toggle"
          onClick={onToggle}
          title={`Afficher la bibliothèque (${shortcuts.toggleSidebar})`}
        >
          <Icon name="panelRight" size={17} />
        </button>
      </div>
    )
  }

  return (
    <aside className="sidebar">
      <header className="sidebar-header" data-tauri-drag-region>
        <div className="header-row">
          <span className="brand" data-tauri-drag-region>
            <span className="brand-mark">
              <Icon name="mark" size={18} />
            </span>
            <span className="brand-name">Notinger</span>
          </span>
          <span className="header-tools">
            <button type="button" onClick={onToggleTheme} title={themeTitle}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
            </button>
            <button
              type="button"
              className="panel-toggle inline"
              onClick={onToggle}
              title={`Replier la bibliothèque (${shortcuts.toggleSidebar})`}
            >
              <Icon name="panelRightChevron" size={17} />
            </button>
          </span>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="primary"
            onClick={onNew}
            title={`Nouveau schéma (${shortcuts.newDrawing})`}
          >
            <Icon name="plus" size={14} />
            Nouveau
          </button>
          <button
            type="button"
            className="ghost icon-only"
            onClick={onImport}
            title={`Importer (${shortcuts.import})`}
          >
            <Icon name="import" size={15} />
          </button>
          <button
            type="button"
            className="ghost icon-only"
            onClick={startFolderDraft}
            title={`Nouveau dossier (${shortcuts.newFolder})`}
          >
            <Icon name="folderPlus" size={15} />
          </button>
        </div>
      </header>

      <div className="search">
        <span className="search-icon">
          <Icon name="search" size={14} />
        </span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Rechercher un schéma…"
          spellCheck={false}
        />
      </div>

      <div
        className="list"
        onScroll={closeContextMenu}
        onDragOver={(event) => {
          allowDrop(event)
          setDropTarget(ROOT)
        }}
        onDrop={(event) => handleDrop(event, ROOT)}
      >
        {draftingFolder && !searching ? (
          <div className="folder-draft">
            <Icon name="folder" size={15} />
            <input
              ref={folderInputRef}
              className="rename-input"
              value={folderDraft}
              placeholder="Nom du dossier"
              onChange={(event) => setFolderDraft(event.target.value)}
              onBlur={commitFolderDraft}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitFolderDraft()
                if (event.key === 'Escape') {
                  setDraftingFolder(false)
                  setFolderDraft('')
                }
              }}
              spellCheck={false}
            />
          </div>
        ) : null}

        {searching
          ? filtered.map((meta) => renderDrawing(meta, true))
          : folders.map((folder) => {
              const drawings = byFolder.get(folder.path) ?? []
              const isCollapsed = collapsedFolders.includes(folder.path)
              return (
                <div
                  className="folder"
                  key={folder.path}
                  onDragOver={(event) => {
                    event.stopPropagation()
                    allowDrop(event)
                    setDropTarget(folder.path)
                  }}
                  onDragEnter={() => {
                    setDropTarget(folder.path)
                    if (isCollapsed) expandFolder(folder.path)
                  }}
                  onDragLeave={clearDrop}
                  onDrop={(event) => handleDrop(event, folder.path)}
                >
                  <div
                    className={dropTarget === folder.path ? 'folder-row is-drop' : 'folder-row'}
                    onContextMenu={(event) => openContextMenu(event, 'folder', folder.path)}
                  >
                    <button
                      type="button"
                      className="folder-toggle"
                      onClick={() => toggleFolder(folder.path)}
                      title={isCollapsed ? 'Déplier' : 'Replier'}
                    >
                      <span className={isCollapsed ? 'chev' : 'chev is-open'}>
                        <Icon name="chevronRight" size={13} />
                      </span>
                    </button>
                    <button
                      type="button"
                      className="folder-main"
                      onClick={() => toggleFolder(folder.path)}
                      onDoubleClick={() => startRenameFolder(folder)}
                      title={folder.path}
                    >
                      <span
                        className="folder-glyph"
                        style={folder.color ? { color: folder.color } : undefined}
                      >
                        <Icon name="folder" size={15} />
                      </span>
                      {editing?.kind === 'folder' && editing.id === folder.path ? (
                        <input
                          ref={inputRef}
                          className="rename-input"
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          onBlur={commitEdit}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') commitEdit()
                            if (event.key === 'Escape') cancelEdit()
                          }}
                          spellCheck={false}
                        />
                      ) : (
                        <span className="folder-name">{folder.name}</span>
                      )}
                      <span className="folder-count">{drawings.length}</span>
                    </button>
                  </div>
                  {!isCollapsed ? (
                    drawings.length > 0 ? (
                      <div className="folder-children">
                        {drawings.map((meta) => renderDrawing(meta))}
                      </div>
                    ) : (
                      <p className="folder-empty">Dossier vide — dépose un schéma ici</p>
                    )
                  ) : null}
                </div>
              )
            })}

        {!searching && folders.length > 0 ? (
          <div
            className={[
              'root-zone',
              draggingId ? 'is-dragging' : '',
              dropTarget === ROOT ? 'is-drop' : ''
            ]
              .filter(Boolean)
              .join(' ')}
            onDragOver={(event) => {
              allowDrop(event)
              setDropTarget(ROOT)
            }}
            onDragLeave={clearDrop}
            onDrop={(event) => handleDrop(event, ROOT)}
          >
            <div className="group-header">
              <span>Sans dossier</span>
              <span className="folder-count">{rootDrawings.length}</span>
            </div>
            {rootDrawings.map((meta) => renderDrawing(meta))}
          </div>
        ) : !searching ? (
          rootDrawings.map((meta) => renderDrawing(meta))
        ) : null}

        {searching && filtered.length === 0 ? (
          <p className="empty">Aucun schéma trouvé</p>
        ) : null}
        {!searching && metas.length === 0 && folders.length === 0 ? (
          <p className="empty">Aucun schéma pour le moment</p>
        ) : null}
      </div>

      <footer className="sidebar-footer">
        <div className="footer-row">
          {isTauri() ? (
            <button
              type="button"
              className="link update-check"
              onClick={onCheckUpdates}
              disabled={
                updateStatus === 'checking' ||
                updateStatus === 'downloading' ||
                updateStatus === 'installing'
              }
              title="Interroger le serveur de mises à jour"
            >
              {updateStatus === 'checking' ? (
                <span className="spinning">
                  <Icon name="refresh" size={11} />
                </span>
              ) : updateStatus === 'up-to-date' ? (
                <Icon name="check" size={11} />
              ) : (
                <Icon name="refresh" size={11} />
              )}
              {updateCheckLabel(updateStatus)}
            </button>
          ) : null}
          <span className="app-version" title="Version installée">
            v{appVersion}
          </span>
        </div>
      </footer>

      {contextMenu && (contextMeta || contextFolder) ? (
        <>
          <div
            className="menu-backdrop"
            onMouseDown={closeContextMenu}
            onContextMenu={(event) => event.preventDefault()}
          />
          <div
            className="context-menu"
            style={{ top: contextMenu.top, left: contextMenu.left }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {contextMeta && menuView === 'move' ? (
              <>
                <button
                  type="button"
                  className="context-head"
                  title="Retour"
                  onClick={() => setMenuView('main')}
                >
                  <Icon name="chevronLeft" size={14} />
                  <span className="context-crumb">
                    {contextMeta.folder || 'Sans dossier'}
                  </span>
                </button>
                <span className="context-label">Déplacer vers</span>
                <button
                  type="button"
                  disabled={contextMeta.folder === ROOT}
                  onClick={() => {
                    onMoveDrawing(contextMeta.id, ROOT)
                    closeContextMenu()
                  }}
                >
                  <Icon name="folder" size={13} />
                  Sans dossier
                </button>
                {folders.map((folder) => (
                  <button
                    key={folder.path}
                    type="button"
                    disabled={contextMeta.folder === folder.path}
                    onClick={() => {
                      expandFolder(folder.path)
                      onMoveDrawing(contextMeta.id, folder.path)
                      closeContextMenu()
                    }}
                  >
                    <span
                      className="context-dot"
                      style={folder.color ? { background: folder.color } : undefined}
                    />
                    {folder.path}
                  </button>
                ))}
              </>
            ) : contextMeta ? (
              <>
                <span className="context-title">{contextMeta.name}</span>
                <button type="button" onClick={() => setMenuView('move')}>
                  <Icon name="folderMove" size={13} />
                  Déplacer vers un dossier…
                </button>
                <span className="context-sep" />
                <button
                  type="button"
                  onClick={() => {
                    startRenameDrawing(contextMeta)
                    closeContextMenu()
                  }}
                >
                  <Icon name="pencil" size={13} />
                  Renommer
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onDuplicate(contextMeta.id)
                    closeContextMenu()
                  }}
                >
                  <Icon name="copy" size={13} />
                  Dupliquer
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onReveal(contextMeta.id)
                    closeContextMenu()
                  }}
                >
                  <Icon name="folder" size={13} />
                  {revealLabel}
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    onDelete(contextMeta.id)
                    closeContextMenu()
                  }}
                >
                  <Icon name="trash" size={13} />
                  Placer dans la corbeille
                </button>
              </>
            ) : contextFolder ? (
              <>
                <span className="context-title">{contextFolder.name}</span>
                <button
                  type="button"
                  onClick={() => {
                    expandFolder(contextFolder.path)
                    onNewInFolder(contextFolder.path)
                    closeContextMenu()
                  }}
                >
                  <Icon name="plus" size={13} />
                  Nouveau schéma
                </button>
                <button
                  type="button"
                  onClick={() => {
                    startRenameFolder(contextFolder)
                    closeContextMenu()
                  }}
                >
                  <Icon name="pencil" size={13} />
                  Renommer
                </button>
                <span className="context-label">Couleur</span>
                <div className="swatches">
                  <button
                    type="button"
                    className={
                      contextFolder.color ? 'swatch is-none' : 'swatch is-none is-active'
                    }
                    title="Aucune couleur"
                    onClick={() => {
                      onFolderColor(contextFolder.path, null)
                      closeContextMenu()
                    }}
                  />
                  {FOLDER_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={
                        contextFolder.color === color ? 'swatch is-active' : 'swatch'
                      }
                      style={{ background: color }}
                      title={color}
                      onClick={() => {
                        onFolderColor(contextFolder.path, color)
                        closeContextMenu()
                      }}
                    />
                  ))}
                </div>
                <span className="context-sep" />
                <button
                  type="button"
                  onClick={() => {
                    onRevealFolder(contextFolder.path)
                    closeContextMenu()
                  }}
                >
                  <Icon name="folder" size={13} />
                  {revealLabel}
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    onDeleteFolder(contextFolder.path)
                    closeContextMenu()
                  }}
                >
                  <Icon name="trash" size={13} />
                  Placer dans la corbeille
                </button>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </aside>
  )
}
