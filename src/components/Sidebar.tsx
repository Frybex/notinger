import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './Icon'
import type { DrawingMeta, SaveState } from '../lib/api'
import { revealLabel } from '../lib/platform'

type SidebarProps = {
  metas: DrawingMeta[]
  currentId: string | null
  libraryDir: string
  saveState: SaveState
  collapsed: boolean
  theme: 'light' | 'dark'
  onToggle: () => void
  onToggleTheme: () => void
  onSelect: (id: string) => void
  onNew: () => void
  onImport: () => void
  onRename: (id: string, name: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onReveal: (id: string) => void
  onOpenDir: () => void
}

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

function saveLabel(state: SaveState) {
  if (state === 'saving') return 'Enregistrement…'
  if (state === 'saved') return 'Enregistré'
  if (state === 'error') return "Échec de l'enregistrement"
  return 'Enregistrement automatique'
}

export default function Sidebar({
  metas,
  currentId,
  libraryDir,
  saveState,
  collapsed,
  theme,
  onToggle,
  onToggleTheme,
  onSelect,
  onNew,
  onImport,
  onRename,
  onDuplicate,
  onDelete,
  onReveal,
  onOpenDir
}: SidebarProps) {
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const filtered = useMemo(() => {
    const needle = normalize(query.trim())
    if (!needle) return metas
    return metas.filter((meta) => normalize(meta.id).includes(needle))
  }, [metas, query])

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  const startRename = (id: string) => {
    setEditingId(id)
    setDraft(id)
  }

  const commitRename = () => {
    if (!editingId) return
    const value = draft.trim()
    if (value && value !== editingId) onRename(editingId, value)
    setEditingId(null)
  }

  const themeTitle = theme === 'dark' ? 'Passer en mode clair' : 'Passer en mode nuit (⌘⇧D)'

  if (collapsed) {
    return (
      <div className="panel-indicator" data-tauri-drag-region>
        <button
          type="button"
          className="panel-toggle"
          onClick={onToggle}
          title="Afficher la bibliothèque (⌘B)"
        >
          <Icon name="panelRight" size={17} />
        </button>
      </div>
    )
  }

  return (
    <aside className="sidebar">
      <button
        type="button"
        className="panel-toggle"
        onClick={onToggle}
        title="Replier la bibliothèque (⌘B)"
      >
        <Icon name="panelRightChevron" size={17} />
      </button>
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
          </span>
        </div>
        <div className="header-actions">
          <button type="button" className="primary" onClick={onNew} title="Nouveau schéma (⌘N)">
            <Icon name="plus" size={14} />
            Nouveau
          </button>
          <button type="button" className="ghost" onClick={onImport} title="Importer (⌘O)">
            <Icon name="import" size={14} />
            Importer
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

      <div className="list">
        {filtered.map((meta) => (
          <div key={meta.id} className={meta.id === currentId ? 'item is-active' : 'item'}>
            <button
              type="button"
              className="item-main"
              onClick={() => onSelect(meta.id)}
              onDoubleClick={() => startRename(meta.id)}
            >
              <span className="thumb">
                {meta.thumbnail ? (
                  <img src={meta.thumbnail} alt="" draggable={false} />
                ) : (
                  <span className="thumb-fallback">{meta.id.slice(0, 1).toUpperCase()}</span>
                )}
              </span>
              <span className="item-text">
                {editingId === meta.id ? (
                  <input
                    ref={inputRef}
                    className="rename-input"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename()
                      if (event.key === 'Escape') setEditingId(null)
                    }}
                    spellCheck={false}
                  />
                ) : (
                  <span className="item-name">{meta.id}</span>
                )}
                <span className="item-date">{formatDate(meta.updatedAt)}</span>
              </span>
            </button>
            <div className="item-actions">
              <button type="button" title="Renommer" onClick={() => startRename(meta.id)}>
                <Icon name="pencil" size={14} />
              </button>
              <button type="button" title="Dupliquer" onClick={() => onDuplicate(meta.id)}>
                <Icon name="copy" size={14} />
              </button>
              <button
                type="button"
                title={revealLabel}
                onClick={() => onReveal(meta.id)}
              >
                <Icon name="folder" size={14} />
              </button>
              <button
                type="button"
                title="Placer dans la corbeille"
                className="danger"
                onClick={() => onDelete(meta.id)}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          </div>
        ))}
        {filtered.length === 0 ? <p className="empty">Aucun schéma trouvé</p> : null}
      </div>

      <footer className="sidebar-footer">
        <div className="save-state" data-state={saveState}>
          <span className="status-dot" />
          {saveLabel(saveState)}
        </div>
        <button type="button" className="link" onClick={onOpenDir} title={libraryDir}>
          Ouvrir le dossier
        </button>
      </footer>
    </aside>
  )
}
