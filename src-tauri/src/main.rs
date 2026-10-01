#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
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
    updated_at: u64,
    size: u64,
    thumbnail: Option<String>,
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

fn safe_id(id: &str) -> Result<String, String> {
    let is_file_name = Path::new(id)
        .file_name()
        .map(|name| name == std::ffi::OsStr::new(id))
        .unwrap_or(false);
    if id.is_empty() || id.contains('\0') || !is_file_name {
        return Err("Identifiant invalide".into());
    }
    Ok(id.to_string())
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

fn unique_id(dir: &Path, base: &str, ignore: Option<&str>) -> String {
    let mut name = base.to_string();
    let mut index = 2;
    while dir.join(format!("{name}{EXT}")).exists() && Some(name.as_str()) != ignore {
        name = format!("{base} {index}");
        index += 1;
    }
    name
}

fn meta_for(dir: &Path, id: &str) -> Result<DrawingMeta, String> {
    let path = dir.join(format!("{id}{EXT}"));
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    let updated_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let thumbnail = fs::read(dir.join(THUMB_REL).join(format!("{id}.png")))
        .ok()
        .map(|bytes| format!("data:image/png;base64,{}", B64.encode(bytes)));
    Ok(DrawingMeta {
        id: id.to_string(),
        name: id.to_string(),
        updated_at,
        size: metadata.len(),
        thumbnail,
    })
}

fn list_metas(dir: &Path) -> Vec<DrawingMeta> {
    let mut metas = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if entry.path().is_file() && file_name.ends_with(EXT) {
                let id = file_name.trim_end_matches(EXT).to_string();
                if let Ok(meta) = meta_for(dir, &id) {
                    metas.push(meta);
                }
            }
        }
    }
    metas.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    metas
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

    if path.parent().map(|parent| parent == dir).unwrap_or(false) {
        return Some(stem);
    }

    let content = fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&content).ok()?;
    if parsed.get("type").and_then(|value| value.as_str()) != Some("excalidraw") {
        return None;
    }

    let base = sanitize_name(&stem);
    let existing = dir.join(format!("{base}{EXT}"));
    if let Ok(existing_content) = fs::read_to_string(&existing) {
        if let Ok(existing_value) = serde_json::from_str::<serde_json::Value>(&existing_content) {
            if existing_value.get("elements") == parsed.get("elements") {
                return Some(base);
            }
        }
    }

    let id = unique_id(dir, &base, None);
    fs::write(dir.join(format!("{id}{EXT}")), content).ok()?;
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
    let id = safe_id(&id)?;
    fs::read_to_string(dir.join(format!("{id}{EXT}"))).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_drawing(app: AppHandle, id: String, data: String) -> Result<DrawingMeta, String> {
    let dir = library_dir(&app)?;
    let id = safe_id(&id)?;
    let file = dir.join(format!("{id}{EXT}"));
    let tmp = dir.join(format!(".{id}{EXT}.tmp"));
    fs::write(&tmp, &data).map_err(|error| error.to_string())?;
    fs::rename(&tmp, &file).map_err(|error| error.to_string())?;
    meta_for(&dir, &id)
}

#[tauri::command]
fn create_drawing(app: AppHandle, name: Option<String>) -> Result<DrawingMeta, String> {
    let dir = library_dir(&app)?;
    let base = sanitize_name(name.as_deref().unwrap_or("Sans titre"));
    let id = unique_id(&dir, &base, None);
    let empty = serde_json::json!({
        "type": "excalidraw",
        "version": 2,
        "source": "notinger",
        "elements": [],
        "appState": {},
        "files": {}
    })
    .to_string();
    fs::write(dir.join(format!("{id}{EXT}")), empty).map_err(|error| error.to_string())?;
    meta_for(&dir, &id)
}

#[tauri::command]
fn rename_drawing(app: AppHandle, id: String, new_name: String) -> Result<DrawingMeta, String> {
    let dir = library_dir(&app)?;
    let id = safe_id(&id)?;
    let base = sanitize_name(&new_name);
    let new_id = unique_id(&dir, &base, Some(&id));
    if new_id != id {
        fs::rename(
            dir.join(format!("{id}{EXT}")),
            dir.join(format!("{new_id}{EXT}")),
        )
        .map_err(|error| error.to_string())?;
        let old_thumb = dir.join(THUMB_REL).join(format!("{id}.png"));
        if old_thumb.exists() {
            let _ = fs::rename(old_thumb, dir.join(THUMB_REL).join(format!("{new_id}.png")));
        }
    }
    meta_for(&dir, &new_id)
}

#[tauri::command]
fn duplicate_drawing(app: AppHandle, id: String) -> Result<DrawingMeta, String> {
    let dir = library_dir(&app)?;
    let id = safe_id(&id)?;
    let new_id = unique_id(&dir, &format!("{id} copie"), None);
    fs::copy(
        dir.join(format!("{id}{EXT}")),
        dir.join(format!("{new_id}{EXT}")),
    )
    .map_err(|error| error.to_string())?;
    let old_thumb = dir.join(THUMB_REL).join(format!("{id}.png"));
    if old_thumb.exists() {
        let _ = fs::copy(old_thumb, dir.join(THUMB_REL).join(format!("{new_id}.png")));
    }
    meta_for(&dir, &new_id)
}

#[tauri::command]
fn delete_drawing(app: AppHandle, id: String) -> Result<(), String> {
    let dir = library_dir(&app)?;
    let id = safe_id(&id)?;
    let file = dir.join(format!("{id}{EXT}"));
    if file.exists() && trash::delete(&file).is_err() {
        fs::remove_file(&file).map_err(|error| error.to_string())?;
    }
    let _ = fs::remove_file(dir.join(THUMB_REL).join(format!("{id}.png")));
    Ok(())
}

#[tauri::command]
fn save_thumbnail(app: AppHandle, id: String, png_base64: String) -> Result<(), String> {
    let dir = library_dir(&app)?;
    let id = safe_id(&id)?;
    let raw = png_base64.split(',').next_back().unwrap_or(&png_base64);
    let bytes = B64.decode(raw.trim()).map_err(|error| error.to_string())?;
    fs::write(dir.join(THUMB_REL).join(format!("{id}.png")), bytes)
        .map_err(|error| error.to_string())
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
    let id = safe_id(&id)?;
    reveal_in_file_manager(&dir.join(format!("{id}{EXT}"))).map_err(|error| error.to_string())
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
            "new" | "import" | "save" | "open_dir" | "toggle_sidebar" | "toggle_theme"
        ) {
            let _ = app.emit("menu", id);
        }
    });
    Ok(())
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
            frontend_ready
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
        assert_eq!(unique_id(&dir, "Note", None), "Note 2");
        assert_eq!(unique_id(&dir, "Note", Some("Note")), "Note");
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

    #[test]
    fn safe_id_rejects_traversal() {
        assert!(safe_id("../secret").is_err());
        assert!(safe_id("a/b").is_err());
        assert!(safe_id("").is_err());
        assert!(safe_id("Mon schéma").is_ok());
    }
}
