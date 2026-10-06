# Notinger — schémas et notes visuelles 100 % locaux

App Tauri v2 (Rust + React/Vite), 100 % locale. Les données vivent dans le dossier Documents de l'utilisateur : `~/Documents/Notinger` (macOS) ou `%USERPROFILE%\Documents\Notinger` (Windows).

Construit avec [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT, Copyright (c) 2020 Excalidraw) utilisé comme librairie npm (`@excalidraw/excalidraw`). Ce projet n'est pas affilié à l'équipe Excalidraw.

## Installer

1. Ouvre la page [Releases](https://github.com/Frybex/notinger/releases/latest).
2. Télécharge l'installeur correspondant à ta machine :
   - **macOS (Apple Silicon)** : `Notinger_x.y.z_aarch64.dmg`
   - **Windows** : `Notinger_x.y.z_x64-setup.exe`
3. L'application n'étant pas signée, le premier lancement demande une confirmation :
   - macOS : clic droit sur l'application → **Ouvrir**.
   - Windows : **Informations complémentaires** → **Exécuter quand même**.

Ensuite, Notinger vérifie les mises à jour au démarrage (via `latest.json` publié dans ce même dépôt) et les installe en un clic, directement depuis l'application.

## Données

Tout est stocké localement dans `~/Documents/Notinger` (macOS) ou `%USERPROFILE%\Documents\Notinger` (Windows). Les mises à jour ne touchent jamais à tes fichiers.

## Migration depuis notinger-releases

Les versions ≤ 1.0.2 interrogent encore `https://github.com/Frybex/notinger-releases/releases/latest/download/latest.json`. Le dépôt `Frybex/notinger-releases` est conservé pour ces anciennes versions. Les nouvelles versions interrogent `https://github.com/Frybex/notinger/releases/latest/download/latest.json`.
