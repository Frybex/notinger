import { invoke } from '@tauri-apps/api/core'

export type DrawingMeta = {
  id: string
  name: string
  updatedAt: number
  size: number
  thumbnail: string | null
}

export type LibraryInfo = {
  dir: string
  count: number
}

export type ImportedFile = {
  name: string
  data: string
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export const api = {
  listDrawings: () => invoke<DrawingMeta[]>('list_drawings'),
  libraryInfo: () => invoke<LibraryInfo>('library_info'),
  readDrawing: (id: string) => invoke<string>('read_drawing', { id }),
  writeDrawing: (id: string, data: string) => invoke<DrawingMeta>('write_drawing', { id, data }),
  createDrawing: (name?: string) => invoke<DrawingMeta>('create_drawing', { name: name ?? null }),
  renameDrawing: (id: string, newName: string) =>
    invoke<DrawingMeta>('rename_drawing', { id, newName }),
  duplicateDrawing: (id: string) => invoke<DrawingMeta>('duplicate_drawing', { id }),
  deleteDrawing: (id: string) => invoke<void>('delete_drawing', { id }),
  saveThumbnail: (id: string, pngBase64: string) =>
    invoke<void>('save_thumbnail', { id, pngBase64 }),
  readImports: (paths: string[]) => invoke<ImportedFile[]>('read_imports', { paths }),
  revealDrawing: (id: string) => invoke<void>('reveal_drawing', { id }),
  openLibraryDir: () => invoke<void>('open_library_dir'),
  flushComplete: () => invoke<void>('flush_complete'),
  frontendReady: () => invoke<string[]>('frontend_ready')
}
