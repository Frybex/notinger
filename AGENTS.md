# AGENTS.md

Notinger : app Tauri v2 (Rust + React/Vite), 100 % locale. Les données vivent dans le dossier Documents de l'utilisateur : `~/Documents/Notinger` (macOS) ou `%USERPROFILE%\Documents\Notinger` (Windows, souvent redirigé vers OneDrive).

## Après chaque implémentation : rebuild + réinstaller

Les sources modifiées ne sont visibles qu'après un rebuild. `npm run app:install` (défini dans `package.json`, implémenté par `scripts/app-install.mjs`) gère macOS et Windows :

```sh
npm run app:install
```

- macOS : build le front + Rust, remplace `/Applications/Notinger.app`, supprime le bundle local généré et fait `killall Dock`. Quitte l'app avant si besoin : `osascript -e 'quit app "Notinger"' 2>/dev/null; sleep 1`.
- Windows : build le front + Rust, génère l'installeur NSIS, ferme une éventuelle instance, l'installe silencieusement dans `%LOCALAPPDATA%\Notinger` (pas de doublon, mise à jour en place) et lance l'app.

## Ne jamais créer de doublon

- Ne pas copier/dupliquer l'app à la main (ni dans `/Applications` ni dans `%LOCALAPPDATA%\Notinger`) : un second exemplaire crée un doublon dans le Launchpad ou le menu Démarrer.
- Toujours passer par `npm run app:install`, qui remplace l'existant et nettoie le bundle local.
- `npm run app:dev` est réservé au cas où aucune app installée ne tourne : le plugin single-instance fait qu'une seule instance `com.bloem.notinger` peut vivre à la fois (`single-instance` fonctionne aussi sous Windows).

## Vérifications avant d'installer

```sh
npx tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml
```

Prérequis Windows : Rust (toolchain MSVC) + WebView2 (fourni avec Windows 11). Le build local n'est pas obligatoire : le workflow GitHub `.github/workflows/build.yml` produit déjà les installeurs `.exe` / `.msi` via `gh workflow run build.yml` ou un tag `v*`.
