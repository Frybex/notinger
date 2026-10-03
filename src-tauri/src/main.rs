#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod scroll_device;

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Serialize;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter, Manager, RunEvent, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

const EXT: &str = ".excalidraw";
const THUMB_REL: &str = ".notinger/thumbnails";
const COLORS_REL: &str = ".notinger/folders.json";
const FLUSH_GRACE_MS: u64 = 1600;

#[derive(Default)]
struct CloseGate {
    flushed: AtomicBool,
    quitting: AtomicBool,
}

#[derive(Default)]
struct OpenGate {
    ready: AtomicBool,
    ever_ready: AtomicBool,
    pending: Mutex<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DrawingMeta {
    id: String,
    name: String,
    folder: String,
    updated_at: u64,
    size: u64,
    thumbnail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderInfo {
    path: String,
    name: String,
    color: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryInfo {
    dir: String,
    count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedFile {
    name: String,
    data: String,
}

fn library_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .document_dir()
        .map_err(|error| error.to_string())?
        .join("Notinger");
    fs::create_dir_all(dir.join(THUMB_REL)).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn safe_rel(raw: &str) -> Result<String, String> {
    if raw.is_empty() || raw.contains('\0') {
        return Err("Identifiant invalide".into());
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in raw.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.starts_with('.')
            || part.contains('\\')
            || part.contains(':')
        {
            return Err("Identifiant invalide".into());
        }
        parts.push(part);
    }
    Ok(parts.join("/"))
}

fn safe_folder(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Ok(String::new());
    }
    safe_rel(raw).map_err(|_| "Dossier invalide".into())
}

fn split_folder(id: &str) -> (&str, &str) {
    match id.rsplit_once('/') {
        Some((folder, base)) => (folder, base),
        None => ("", id),
    }
}

fn drawing_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}{EXT}"))
}

fn thumbnail_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(THUMB_REL).join(format!("{id}.png"))
}

fn relative_id(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for component in rel.components() {
        match component {
            std::path::Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            _ => return None,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn sanitize_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '\0') { ' ' } else { c })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_start_matches('.').trim();
    let limited: String = trimmed.chars().take(120).collect();
    if limited.is_empty() {
        "Sans titre".to_string()
    } else {
        limited
    }
}

fn unique_id(dir: &Path, folder: &str, base: &str, ignore: Option<&str>) -> String {
    let parent = if folder.is_empty() {
        dir.to_path_buf()
    } else {
        dir.join(folder)
    };
    let mut name = base.to_string();
    let mut index = 2;
    loop {
        let candidate = if folder.is_empty() {
            name.clone()
        } else {
            format!("{folder}/{name}")
        };
        if !parent.join(format!("{name}{EXT}")).exists() || Some(candidate.as_str()) == ignore {
            return candidate;
        }
        name = format!("{base} {index}");
        index += 1;
    }
}

fn unique_folder(dir: &Path, parent: &str, base: &str, ignore: Option<&str>) -> String {
    let parent_path = if parent.is_empty() {
        dir.to_path_buf()
    } else {
        dir.join(parent)
    };
    let mut name = base.to_string();
    let mut index = 2;
    loop {
        let candidate = if parent.is_empty() {
            name.clone()
        } else {
            format!("{parent}/{name}")
        };
        if !parent_path.join(&name).exists() || Some(candidate.as_str()) == ignore {
            return candidate;
        }
        name = format!("{base} {index}");
        index += 1;
    }
}

fn meta_for(dir: &Path, id: &str) -> Result<DrawingMeta, String> {
    let path = drawing_path(dir, id);
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    let updated_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let thumbnail = fs::read(thumbnail_path(dir, id))
        .ok()
        .map(|bytes| format!("data:image/png;base64,{}", B64.encode(bytes)));
    let (folder, name) = split_folder(id);
    Ok(DrawingMeta {
        id: id.to_string(),
        name: name.to_string(),
        folder: folder.to_string(),
        updated_at,
        size: metadata.len(),
        thumbnail,
    })
}

fn collect_drawings(root: &Path, dir: &Path, metas: &mut Vec<DrawingMeta>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_drawings(root, &path, metas);
        } else if file_name.ends_with(EXT) {
            if let Some(rel) = relative_id(root, &path) {
                let id = rel.strip_suffix(EXT).unwrap_or(&rel).to_string();
                if safe_rel(&id).is_ok() {
                    if let Ok(meta) = meta_for(root, &id) {
                        metas.push(meta);
                    }
                }
            }
        }
    }
}

fn list_metas(dir: &Path) -> Vec<DrawingMeta> {
    let mut metas = Vec::new();
    collect_drawings(dir, dir, &mut metas);
    metas.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    metas
}

fn colors_path(root: &Path) -> PathBuf {
    root.join(COLORS_REL)
}

fn read_folder_colors(root: &Path) -> BTreeMap<String, String> {
    fs::read_to_string(colors_path(root))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_folder_colors(root: &Path, colors: &BTreeMap<String, String>) -> Result<(), String> {
    let path = colors_path(root);
    if colors.is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let data = serde_json::to_string_pretty(colors).map_err(|error| error.to_string())?;
    fs::write(path, data).map_err(|error| error.to_string())
}

fn valid_color(color: &str) -> bool {
    color.len() == 7
        && color.starts_with('#')
        && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn set_folder_color_at(root: &Path, folder: &str, color: Option<&str>) -> Result<(), String> {
    let folder = safe_rel(folder).map_err(|_| "Dossier invalide".to_string())?;
    if !root.join(&folder).is_dir() {
        return Err("Dossier introuvable".into());
    }
    let mut colors = read_folder_colors(root);
    match color {
        Some(value) if valid_color(value) => {
            colors.insert(folder, value.to_lowercase());
        }
        Some(_) => return Err("Couleur invalide".into()),
        None => {
            colors.remove(&folder);
        }
    }
    write_folder_colors(root, &colors)
}

fn collect_folders(
    root: &Path,
    dir: &Path,
    colors: &BTreeMap<String, String>,
    out: &mut Vec<FolderInfo>,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            if let Some(rel) = relative_id(root, &path) {
                if safe_rel(&rel).is_ok() {
                    let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
                    let color = colors.get(&rel).cloned();
                    out.push(FolderInfo { path: rel, name, color });
                }
            }
            collect_folders(root, &path, colors, out);
        }
    }
}

fn list_folders_at(root: &Path) -> Vec<FolderInfo> {
    let colors = read_folder_colors(root);
    let mut folders = Vec::new();
    collect_folders(root, root, &colors, &mut folders);
    folders.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    folders
}

fn create_folder_at(root: &Path, name: &str) -> Result<FolderInfo, String> {
    let base = sanitize_name(name);
    let path = unique_folder(root, "", &base, None);
    fs::create_dir_all(root.join(&path)).map_err(|error| error.to_string())?;
    let display = path.rsplit('/').next().unwrap_or(&path).to_string();
    Ok(FolderInfo {
        path,
        name: display,
        color: None,
    })
}

fn rename_folder_at(root: &Path, folder: &str, new_name: &str) -> Result<FolderInfo, String> {
    let folder = safe_rel(folder).map_err(|_| "Dossier invalide".to_string())?;
    if !root.join(&folder).is_dir() {
        return Err("Dossier introuvable".into());
    }
    let (parent, _) = split_folder(&folder);
    let base = sanitize_name(new_name);
    let new_id = unique_folder(root, parent, &base, Some(&folder));
    if new_id != folder {
        fs::rename(root.join(&folder), root.join(&new_id)).map_err(|error| error.to_string())?;
        let old_thumbs = root.join(THUMB_REL).join(&folder);
        if old_thumbs.exists() {
            let new_thumbs = root.join(THUMB_REL).join(&new_id);
            if let Some(parent) = new_thumbs.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::rename(old_thumbs, new_thumbs);
        }
        let colors = read_folder_colors(root);
        let nested = format!("{folder}/");
        let mut moved = colors.clone();
        let mut changed = false;
        for (key, value) in &colors {
            if key == &folder {
                moved.remove(key);
                moved.insert(new_id.clone(), value.clone());
                changed = true;
            } else if let Some(rest) = key.strip_prefix(&nested) {
                moved.remove(key);
                moved.insert(format!("{new_id}/{rest}"), value.clone());
                changed = true;
            }
        }
        if changed {
            write_folder_colors(root, &moved)?;
        }
    }
    let colors = read_folder_colors(root);
    let display = new_id.rsplit('/').next().unwrap_or(&new_id).to_string();
    Ok(FolderInfo {
        color: colors.get(&new_id).cloned(),
        path: new_id,
        name: display,
    })
}

fn move_drawing_at(root: &Path, id: &str, folder: &str) -> Result<DrawingMeta, String> {
    let id = safe_rel(id).map_err(|_| "Identifiant invalide".to_string())?;
    let folder = safe_folder(folder)?;
    if !folder.is_empty() && !root.join(&folder).is_dir() {
        return Err("Dossier introuvable".into());
    }
    if split_folder(&id).0 == folder {
        return meta_for(root, &id);
    }
    let (_, base) = split_folder(&id);
    let new_id = unique_id(root, &folder, base, Some(&id));
    let target = if folder.is_empty() {
        root.to_path_buf()
    } else {
        root.join(&folder)
    };
    fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    fs::rename(drawing_path(root, &id), drawing_path(root, &new_id))
        .map_err(|error| error.to_string())?;
    let old_thumb = thumbnail_path(root, &id);
    if old_thumb.exists() {
        let new_thumb = thumbnail_path(root, &new_id);
        if let Some(parent) = new_thumb.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::rename(old_thumb, new_thumb);
    }
    meta_for(root, &new_id)
}

fn create_main_window(app: &AppHandle) -> Option<WebviewWindow> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")?
        .clone();
    let window = WebviewWindowBuilder::from_config(app, &config)
        .ok()?
        .build()
        .ok()?;
    app.state::<CloseGate>().flushed.store(false, Ordering::SeqCst);
    app.state::<OpenGate>().ready.store(false, Ordering::SeqCst);
    Some(window)
}

fn ensure_main_window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(window) = app.get_webview_window("main") {
        return Some(window);
    }
    let inner = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        let handle = inner.clone();
        let _ = inner.run_on_main_thread(move || {
            if handle.get_webview_window("main").is_none() {
                let _ = create_main_window(&handle);
            }
        });
    });
    None
}

fn deliver_open(app: &AppHandle, id: String) {
    let window_exists = app.get_webview_window("main").is_some();
    let gate = app.state::<OpenGate>();
    if window_exists && gate.ready.load(Ordering::SeqCst) {
        let _ = app.emit("open-drawing", id);
        return;
    }
    if !window_exists && gate.ever_ready.load(Ordering::SeqCst) {
        ensure_main_window(app);
    }
    let mut queue = gate.pending.lock().ok();
    if let Some(pending) = queue.as_mut() {
        pending.push(id);
    }
}

fn import_or_match(dir: &Path, path: &Path) -> Option<String> {
    let file_name = path.file_name()?.to_string_lossy().to_string();
    let stem = file_name
        .strip_suffix(EXT)
        .or_else(|| file_name.strip_suffix(".json"))?
        .to_string();

    if path.extension().map(|ext| ext == "excalidraw").unwrap_or(false) {
        if let Some(rel) = relative_id(dir, path) {
            let id = rel.strip_suffix(EXT).unwrap_or(&rel).to_string();
            if safe_rel(&id).is_ok() {
                return Some(id);
            }
        }
    }

    if path.parent().map(|parent| parent == dir).unwrap_or(false) {
        return Some(stem);
    }

    let content = fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&content).ok()?;
    if parsed.get("type").and_then(|value| value.as_str()) != Some("excalidraw") {
        return None;
    }

    let base = sanitize_name(&stem);
    let existing = drawing_path(dir, &base);
    if let Ok(existing_content) = fs::read_to_string(&existing) {
        if let Ok(existing_value) = serde_json::from_str::<serde_json::Value>(&existing_content) {
            if existing_value.get("elements") == parsed.get("elements") {
                return Some(base);
            }
        }
    }

    let id = unique_id(dir, "", &base, None);
    fs::write(drawing_path(dir, &id), content).ok()?;
    Some(id)
}

fn open_paths(app: &AppHandle, paths: impl IntoIterator<Item = PathBuf>) {
    let dir = match library_dir(app) {
        Ok(dir) => dir,
        Err(_) => return,
    };
    for path in paths {
        if let Some(id) = import_or_match(&dir, &path) {
            deliver_open(app, id);
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
fn handle_open_urls(app: &AppHandle, urls: Vec<tauri::Url>) {
    let paths: Vec<PathBuf> = urls.iter().filter_map(|url| url.to_file_path().ok()).collect();
    open_paths(app, paths);
}

fn command_line_paths() -> Vec<PathBuf> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .collect()
}

#[tauri::command]
fn frontend_ready(app: AppHandle) -> Vec<String> {
    let gate = app.state::<OpenGate>();
    gate.ready.store(true, Ordering::SeqCst);
    gate.ever_ready.store(true, Ordering::SeqCst);
    gate.pending
        .lock()
        .map(|mut pending| std::mem::take(&mut *pending))
        .unwrap_or_default()
}

fn emit_flush_and_watch(app: &AppHandle, quit_after: bool) {
    let gate = app.state::<CloseGate>();
    gate.quitting.store(quit_after, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("app://flush", ());
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(FLUSH_GRACE_MS));
        let timed_out = {
            let gate = handle.state::<CloseGate>();
            !gate.flushed.swap(true, Ordering::SeqCst)
        };
        if !timed_out {
            return;
        }
        let quitting = handle.state::<CloseGate>().quitting.load(Ordering::SeqCst);
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if quitting {
                inner.exit(0);
            } else if let Some(window) = inner.get_webview_window("main") {
                let _ = window.destroy();
            }
        });
    });
}

#[tauri::command]
fn list_drawings(app: AppHandle) -> Result<Vec<DrawingMeta>, String> {
    Ok(list_metas(&library_dir(&app)?))
}

#[tauri::command]
fn list_folders(app: AppHandle) -> Result<Vec<FolderInfo>, String> {
    Ok(list_folders_at(&library_dir(&app)?))
}

#[tauri::command]
fn create_folder(app: AppHandle, name: String) -> Result<FolderInfo, String> {
    create_folder_at(&library_dir(&app)?, &name)
}

#[tauri::command]
fn rename_folder(app: AppHandle, path: String, new_name: String) -> Result<FolderInfo, String> {
    rename_folder_at(&library_dir(&app)?, &path, &new_name)
}

#[tauri::command]
fn set_folder_color(app: AppHandle, path: String, color: Option<String>) -> Result<(), String> {
    set_folder_color_at(&library_dir(&app)?, &path, color.as_deref())
}

#[tauri::command]
fn delete_folder(app: AppHandle, path: String) -> Result<(), String> {
    let dir = library_dir(&app)?;
    let folder = safe_folder(&path)?;
    if folder.is_empty() {
        return Err("Dossier invalide".into());
    }
    let target = dir.join(&folder);
    if target.is_dir() && trash::delete(&target).is_err() {
        fs::remove_dir_all(&target).map_err(|error| error.to_string())?;
    }
    let _ = fs::remove_dir_all(dir.join(THUMB_REL).join(&folder));
    let mut colors = read_folder_colors(&dir);
    let before = colors.len();
    let nested = format!("{folder}/");
    colors.retain(|key, _| key != &folder && !key.starts_with(&nested));
    if colors.len() != before {
        let _ = write_folder_colors(&dir, &colors);
    }
    Ok(())
}

#[tauri::command]
fn move_drawing(app: AppHandle, id: String, folder: Option<String>) -> Result<DrawingMeta, String> {
    let dir = library_dir(&app)?;
    move_drawing_at(&dir, &id, folder.as_deref().unwrap_or(""))
}

#[tauri::command]
fn reveal_folder(app: AppHandle, path: String) -> Result<(), String> {
    let dir = library_dir(&app)?;
    let folder = safe_folder(&path)?;
    if folder.is_empty() {
        return open_in_file_manager(&dir).map_err(|error| error.to_string());
    }
    open_in_file_manager(&dir.join(&folder)).map_err(|error| error.to_string())
}

#[tauri::command]
fn library_info(app: AppHandle) -> Result<LibraryInfo, String> {
    let dir = library_dir(&app)?;
    Ok(LibraryInfo {
        count: list_metas(&dir).len(),
        dir: dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn read_drawing(app: AppHandle, id: String) -> Result<String, String> {
    let dir = library_dir(&app)?;
    let id = safe_rel(&id)?;
    fs::read_to_string(drawing_path(&dir, &id)).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_drawing(app: AppHandle, id: String, data: String) -> Result<DrawingMeta, String> {
    let dir = library_dir(&app)?;
    let id = safe_rel(&id)?;
    let file = drawing_path(&dir, &id);
    let file_name = file
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("{id}{EXT}"));
    let parent = file.parent().unwrap_or(&dir);
    let tmp = parent.join(format!(".{file_name}.tmp"));
    fs::write(&tmp, &data).map_err(|error| error.to_string())?;
    fs::rename(&tmp, &file).map_err(|error| error.to_string())?;
    meta_for(&dir, &id)
}

#[tauri::command]
fn create_drawing(
    app: AppHandle,
    name: Option<String>,
    folder: Option<String>,
) -> Result<DrawingMeta, String> {
    let dir = library_dir(&app)?;
    let folder = safe_folder(folder.as_deref().unwrap_or(""))?;
    if !folder.is_empty() {
        fs::create_dir_all(dir.join(&folder)).map_err(|error| error.to_string())?;
    }
    let base = sanitize_name(name.as_deref().unwrap_or("Sans titre"));
    let id = unique_id(&dir, &folder, &base, None);
    let empty = serde_json::json!({
        "type": "excalidraw",
        "version": 2,
        "source": "notinger",
        "elements": [],
        "appState": {},
        "files": {}
    })
    .to_string();
    fs::write(drawing_path(&dir, &id), empty).map_err(|error| error.to_string())?;
    meta_for(&dir, &id)
}

#[tauri::command]
fn rename_drawing(app: AppHandle, id: String, new_name: String) -> Result<DrawingMeta, String> {
    let dir = library_dir(&app)?;
    let id = safe_rel(&id)?;
    let (folder, _) = split_folder(&id);
    let base = sanitize_name(&new_name);
    let new_id = unique_id(&dir, folder, &base, Some(&id));
    if new_id != id {
        fs::rename(drawing_path(&dir, &id), drawing_path(&dir, &new_id))
            .map_err(|error| error.to_string())?;
        let old_thumb = thumbnail_path(&dir, &id);
        if old_thumb.exists() {
            let _ = fs::rename(old_thumb, thumbnail_path(&dir, &new_id));
        }
    }
    meta_for(&dir, &new_id)
}

#[tauri::command]
fn duplicate_drawing(app: AppHandle, id: String) -> Result<DrawingMeta, String> {
    let dir = library_dir(&app)?;
    let id = safe_rel(&id)?;
    let (folder, base) = split_folder(&id);
    let new_id = unique_id(&dir, folder, &format!("{base} copie"), None);
    fs::copy(drawing_path(&dir, &id), drawing_path(&dir, &new_id))
        .map_err(|error| error.to_string())?;
    let old_thumb = thumbnail_path(&dir, &id);
    if old_thumb.exists() {
        let _ = fs::copy(old_thumb, thumbnail_path(&dir, &new_id));
    }
    meta_for(&dir, &new_id)
}

#[tauri::command]
fn delete_drawing(app: AppHandle, id: String) -> Result<(), String> {
    let dir = library_dir(&app)?;
    let id = safe_rel(&id)?;
    let file = drawing_path(&dir, &id);
    if file.exists() && trash::delete(&file).is_err() {
        fs::remove_file(&file).map_err(|error| error.to_string())?;
    }
    let _ = fs::remove_file(thumbnail_path(&dir, &id));
    Ok(())
}

#[tauri::command]
fn save_thumbnail(app: AppHandle, id: String, png_base64: String) -> Result<(), String> {
    let dir = library_dir(&app)?;
    let id = safe_rel(&id)?;
    let raw = png_base64.split(',').next_back().unwrap_or(&png_base64);
    let bytes = B64.decode(raw.trim()).map_err(|error| error.to_string())?;
    let target = thumbnail_path(&dir, &id);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(target, bytes).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_imports(paths: Vec<String>) -> Result<Vec<ImportedFile>, String> {
    paths
        .iter()
        .map(|path| {
            let path = PathBuf::from(path);
            let name = path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| "import".to_string());
            let bytes = fs::read(&path).map_err(|error| error.to_string())?;
            Ok(ImportedFile {
                name,
                data: B64.encode(bytes),
            })
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn reveal_in_file_manager(path: &Path) -> std::io::Result<()> {
    Command::new("open").arg("-R").arg(path).spawn().map(|_| ())
}

#[cfg(target_os = "windows")]
fn reveal_in_file_manager(path: &Path) -> std::io::Result<()> {
    Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .spawn()
        .map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal_in_file_manager(path: &Path) -> std::io::Result<()> {
    Command::new("xdg-open")
        .arg(path.parent().unwrap_or(path))
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "macos")]
fn open_in_file_manager(path: &Path) -> std::io::Result<()> {
    Command::new("open").arg(path).spawn().map(|_| ())
}

#[cfg(target_os = "windows")]
fn open_in_file_manager(path: &Path) -> std::io::Result<()> {
    Command::new("explorer").arg(path).spawn().map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_in_file_manager(path: &Path) -> std::io::Result<()> {
    Command::new("xdg-open").arg(path).spawn().map(|_| ())
}

#[tauri::command]
fn reveal_drawing(app: AppHandle, id: String) -> Result<(), String> {
    let dir = library_dir(&app)?;
    let id = safe_rel(&id)?;
    reveal_in_file_manager(&drawing_path(&dir, &id)).map_err(|error| error.to_string())
}

#[tauri::command]
fn open_library_dir(app: AppHandle) -> Result<(), String> {
    let dir = library_dir(&app)?;
    open_in_file_manager(&dir).map_err(|error| error.to_string())
}

#[tauri::command]
fn flush_complete(app: AppHandle) {
    let gate = app.state::<CloseGate>();
    gate.flushed.store(true, Ordering::SeqCst);
    if gate.quitting.load(Ordering::SeqCst) {
        app.exit(0);
    } else if let Some(window) = app.get_webview_window("main") {
        let _ = window.destroy();
    }
}

fn build_menu(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle();
    #[cfg(target_os = "macos")]
    let app_menu = Some(
        SubmenuBuilder::new(handle, "Notinger")
            .item(&PredefinedMenuItem::about(
                handle,
                Some("À propos de Notinger"),
                None,
            )?)
            .separator()
            .item(&PredefinedMenuItem::services(handle, Some("Services"))?)
            .separator()
            .item(&PredefinedMenuItem::hide(handle, Some("Masquer Notinger"))?)
            .item(&PredefinedMenuItem::hide_others(
                handle,
                Some("Masquer les autres"),
            )?)
            .item(&PredefinedMenuItem::show_all(handle, Some("Tout afficher"))?)
            .separator()
            .item(&PredefinedMenuItem::quit(
                handle,
                Some("Quitter Notinger"),
            )?)
            .build()?,
    );
    #[cfg(not(target_os = "macos"))]
    let app_menu: Option<tauri::menu::Submenu<tauri::Wry>> = None;
    let file_menu_builder = SubmenuBuilder::new(handle, "Fichier")
        .item(
            &MenuItemBuilder::with_id("new", "Nouveau schéma")
                .accelerator("CmdOrCtrl+N")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::with_id("import", "Importer…")
                .accelerator("CmdOrCtrl+O")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::with_id("new_folder", "Nouveau dossier")
                .accelerator("CmdOrCtrl+Shift+N")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::with_id("save", "Enregistrer maintenant")
                .accelerator("CmdOrCtrl+S")
                .build(handle)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("open_dir", "Afficher le dossier des fichiers").build(handle)?);
    #[cfg(target_os = "macos")]
    let file_menu = file_menu_builder.build()?;
    #[cfg(not(target_os = "macos"))]
    let file_menu = file_menu_builder
        .separator()
        .item(&PredefinedMenuItem::quit(
            handle,
            Some("Quitter Notinger"),
        )?)
        .build()?;
    let edit_menu = SubmenuBuilder::new(handle, "Édition")
        .item(&PredefinedMenuItem::undo(handle, Some("Annuler"))?)
        .item(&PredefinedMenuItem::redo(handle, Some("Rétablir"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(handle, Some("Couper"))?)
        .item(&PredefinedMenuItem::copy(handle, Some("Copier"))?)
        .item(&PredefinedMenuItem::paste(handle, Some("Coller"))?)
        .item(&PredefinedMenuItem::select_all(
            handle,
            Some("Tout sélectionner"),
        )?)
        .build()?;
    let view_menu = SubmenuBuilder::new(handle, "Présentation")
        .item(
            &MenuItemBuilder::with_id("toggle_sidebar", "Afficher / masquer la bibliothèque")
                .accelerator("CmdOrCtrl+B")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::with_id("toggle_theme", "Basculer clair / sombre")
                .accelerator("CmdOrCtrl+Shift+D")
                .build(handle)?,
        )
        .build()?;
    let window_menu = SubmenuBuilder::new(handle, "Fenêtre")
        .item(&PredefinedMenuItem::minimize(handle, Some("Réduire"))?)
        .item(&PredefinedMenuItem::maximize(handle, Some("Zoom"))?)
        .separator()
        .item(&PredefinedMenuItem::close_window(
            handle,
            Some("Fermer la fenêtre"),
        )?)
        .build()?;
    let mut submenus: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = Vec::new();
    if let Some(menu) = app_menu.as_ref() {
        submenus.push(menu);
    }
    submenus.push(&file_menu);
    submenus.push(&edit_menu);
    submenus.push(&view_menu);
    submenus.push(&window_menu);
    let menu = MenuBuilder::new(handle).items(&submenus).build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let id = event.id().0.clone();
        if matches!(
            id.as_str(),
            "new" | "import" | "new_folder" | "save" | "open_dir" | "toggle_sidebar" | "toggle_theme"
        ) {
            let _ = app.emit("menu", id);
        }
    });
    Ok(())
}

#[tauri::command]
fn scroll_device_kind() -> Option<&'static str> {
    scroll_device::current()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(CloseGate::default())
        .manage(OpenGate::default())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths: Vec<PathBuf> = argv
                .iter()
                .skip(1)
                .map(PathBuf::from)
                .filter(|path| path.is_file())
                .collect();
            let app = app.clone();
            let inner = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(window) = inner.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                if !paths.is_empty() {
                    open_paths(&inner, paths);
                }
            });
        }))
        .setup(|app| {
            build_menu(app)?;
            scroll_device::install(app.handle());
            let paths = command_line_paths();
            if !paths.is_empty() {
                open_paths(app.handle(), paths);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle().clone();
                let gate = app.state::<CloseGate>();
                if !gate.flushed.load(Ordering::SeqCst) {
                    api.prevent_close();
                    emit_flush_and_watch(&app, false);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_drawings,
            list_folders,
            create_folder,
            rename_folder,
            delete_folder,
            set_folder_color,
            move_drawing,
            reveal_folder,
            library_info,
            read_drawing,
            write_drawing,
            create_drawing,
            rename_drawing,
            duplicate_drawing,
            delete_drawing,
            save_thumbnail,
            read_imports,
            reveal_drawing,
            open_library_dir,
            flush_complete,
            frontend_ready,
            scroll_device_kind
        ])
        .build(tauri::generate_context!())
        .expect("impossible de démarrer Notinger")
        .run(|app, event| match event {
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            RunEvent::Opened { urls } => handle_open_urls(app, urls),
            #[cfg(target_os = "macos")]
            RunEvent::Reopen {
                has_visible_windows,
                ..
            } => {
                if !has_visible_windows {
                    ensure_main_window(app);
                }
            }
            RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() {
                    let gate = app.state::<CloseGate>();
                    if !gate.flushed.load(Ordering::SeqCst) {
                        api.prevent_exit();
                        emit_flush_and_watch(app, true);
                    }
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_removes_separators() {
        assert_eq!(sanitize_name("a/b:c"), "a b c");
        assert_eq!(sanitize_name("   "), "Sans titre");
        assert_eq!(sanitize_name("..."), "Sans titre");
    }

    #[test]
    fn unique_id_increments_and_ignores_self() {
        let dir = std::env::temp_dir().join("notinger-test-unique-id");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("Note{EXT}")), "{}").unwrap();
        assert_eq!(unique_id(&dir, "", "Note", None), "Note 2");
        assert_eq!(unique_id(&dir, "", "Note", Some("Note")), "Note");
    }

    #[test]
    fn unique_id_scopes_to_folder() {
        let dir = std::env::temp_dir().join("notinger-test-unique-folder-scope");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Projets")).unwrap();
        fs::write(dir.join(format!("Note{EXT}")), "{}").unwrap();
        fs::write(dir.join("Projets").join(format!("Note{EXT}")), "{}").unwrap();
        assert_eq!(unique_id(&dir, "Projets", "Note", None), "Projets/Note 2");
        assert_eq!(unique_id(&dir, "Projets", "Autre", None), "Projets/Autre");
    }

    #[test]
    fn folders_are_created_renamed_and_moved_into() {
        let dir = std::env::temp_dir().join("notinger-test-folders");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(THUMB_REL)).unwrap();
        fs::write(
            dir.join(format!("Note{EXT}")),
            r#"{"type":"excalidraw","elements":[],"appState":{}}"#,
        )
        .unwrap();
        fs::write(dir.join(THUMB_REL).join("Note.png"), "png").unwrap();

        let folder = create_folder_at(&dir, "Projets").unwrap();
        assert_eq!(folder.path, "Projets");
        assert!(dir.join("Projets").is_dir());
        assert_eq!(create_folder_at(&dir, "Projets").unwrap().path, "Projets 2");

        set_folder_color_at(&dir, "Projets", Some("#E5484D")).unwrap();
        assert!(set_folder_color_at(&dir, "Projets", Some("rouge")).is_err());
        assert_eq!(
            list_folders_at(&dir)[0].color.as_deref(),
            Some("#e5484d")
        );

        let meta = move_drawing_at(&dir, "Note", "Projets").unwrap();
        assert_eq!(meta.id, "Projets/Note");
        assert_eq!(meta.name, "Note");
        assert_eq!(meta.folder, "Projets");
        assert!(dir.join("Projets").join(format!("Note{EXT}")).exists());
        assert!(dir
            .join(THUMB_REL)
            .join("Projets")
            .join("Note.png")
            .exists());

        let renamed = rename_folder_at(&dir, "Projets", "Archives").unwrap();
        assert_eq!(renamed.path, "Archives");
        assert_eq!(renamed.color.as_deref(), Some("#e5484d"));
        assert!(dir.join("Archives").join(format!("Note{EXT}")).exists());
        assert_eq!(list_folders_at(&dir).len(), 2);
        assert_eq!(list_metas(&dir).first().unwrap().id, "Archives/Note");

        set_folder_color_at(&dir, "Archives", None).unwrap();
        assert!(list_folders_at(&dir)
            .iter()
            .all(|folder| folder.color.is_none()));

        let root = move_drawing_at(&dir, "Archives/Note", "").unwrap();
        assert_eq!(root.id, "Note");
        assert!(dir.join(format!("Note{EXT}")).exists());
    }

    #[test]
    fn safe_rel_allows_folders_and_rejects_traversal() {
        assert!(safe_rel("../secret").is_err());
        assert!(safe_rel("a/../b").is_err());
        assert!(safe_rel("/abs").is_err());
        assert!(safe_rel(".cache").is_err());
        assert!(safe_rel("").is_err());
        assert!(safe_rel("Mon schéma").is_ok());
        assert_eq!(safe_rel("Projets/2024").unwrap(), "Projets/2024");
        assert!(safe_folder("").is_ok());
        assert!(safe_folder("Projets/2024").is_ok());
        assert!(safe_folder("..").is_err());
    }

    #[test]
    fn import_matches_same_content_and_creates_otherwise() {
        let dir = std::env::temp_dir().join("notinger-test-import-match");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let scene = r#"{"type":"excalidraw","elements":[{"id":"a"}],"appState":{}}"#;
        fs::write(dir.join(format!("Note{EXT}")), scene).unwrap();

        let outside = std::env::temp_dir().join("notinger-test-import-outside");
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).unwrap();
        let same = outside.join("Note.json");
        fs::write(&same, scene).unwrap();
        assert_eq!(import_or_match(&dir, &same).as_deref(), Some("Note"));

        let different = outside.join("Note.excalidraw");
        fs::write(
            &different,
            r#"{"type":"excalidraw","elements":[{"id":"b"}],"appState":{}}"#,
        )
        .unwrap();
        assert_eq!(import_or_match(&dir, &different).as_deref(), Some("Note 2"));
        assert!(dir.join(format!("Note 2{EXT}")).exists());
    }

    #[test]
    fn import_ignores_non_excalidraw_files() {
        let dir = std::env::temp_dir().join("notinger-test-import-invalid");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let other = std::env::temp_dir().join("notinger-test-other.json");
        fs::write(&other, r#"{"type":"excalidrawlib","elements":[]}"#).unwrap();
        assert_eq!(import_or_match(&dir, &other), None);
    }

    #[test]
    fn import_returns_id_for_library_file() {
        let dir = std::env::temp_dir().join("notinger-test-import-inlib");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("Interne{EXT}"));
        fs::write(&path, r#"{"type":"excalidraw","elements":[],"appState":{}}"#).unwrap();
        assert_eq!(import_or_match(&dir, &path).as_deref(), Some("Interne"));
    }
}
