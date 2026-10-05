import { invoke } from '@tauri-apps/api/core'

export type DrawingMeta = {
  id: string
  name: string
  folder: string
  updatedAt: number
  size: number
  thumbnail: string | null
}

export type FolderInfo = {
  path: string
  name: string
  color: string | null
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
  listFolders: () => invoke<FolderInfo[]>('list_folders'),
  libraryInfo: () => invoke<LibraryInfo>('library_info'),
  readDrawing: (id: string) => invoke<string>('read_drawing', { id }),
  writeDrawing: (id: string, data: string) => invoke<DrawingMeta>('write_drawing', { id, data }),
  createDrawing: (name?: string, folder?: string | null) =>
    invoke<DrawingMeta>('create_drawing', { name: name ?? null, folder: folder ?? null }),
  renameDrawing: (id: string, newName: string) =>
    invoke<DrawingMeta>('rename_drawing', { id, newName }),
  duplicateDrawing: (id: string) => invoke<DrawingMeta>('duplicate_drawing', { id }),
  deleteDrawing: (id: string) => invoke<void>('delete_drawing', { id }),
  moveDrawing: (id: string, folder: string | null) =>
    invoke<DrawingMeta>('move_drawing', { id, folder }),
  createFolder: (name: string) => invoke<FolderInfo>('create_folder', { name }),
  renameFolder: (path: string, newName: string) =>
    invoke<FolderInfo>('rename_folder', { path, newName }),
  deleteFolder: (path: string) => invoke<void>('delete_folder', { path }),
  setFolderColor: (path: string, color: string | null) =>
    invoke<void>('set_folder_color', { path, color }),
  revealFolder: (path: string) => invoke<void>('reveal_folder', { path }),
  saveThumbnail: (id: string, pngBase64: string) =>
    invoke<void>('save_thumbnail', { id, pngBase64 }),
  readImports: (paths: string[]) => invoke<ImportedFile[]>('read_imports', { paths }),
  savePdf: (id: string, sourcePath: string) => invoke<void>('save_pdf', { id, sourcePath }),
  readPdf: (id: string) => invoke<string>('read_pdf', { id }),
  revealDrawing: (id: string) => invoke<void>('reveal_drawing', { id }),
  openLibraryDir: () => invoke<void>('open_library_dir'),
  flushComplete: () => invoke<void>('flush_complete'),
  frontendReady: () => invoke<string[]>('frontend_ready')
}
