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

Prérequis Windows : Rust (toolchain MSVC) + WebView2 (fourni avec Windows 11). Le build local n'est pas obligatoire : le workflow GitHub `.github/workflows/build.yml` produit les installeurs `.dmg` / `.exe` / `.msi` (voir « Processus de release »).

## Processus de release

Une release est déclenchée par un tag `v*` : la CI construit macOS (Apple Silicon) et Windows, signe les artefacts de mise à jour et publie le tout dans le dépôt **public** [`Frybex/notinger-releases`](https://github.com/Frybex/notinger-releases) (installeurs + `latest.json`). Le code source reste dans le dépôt privé.

1. Vérifier le code : `npx tsc --noEmit` et `cargo test --manifest-path src-tauri/Cargo.toml`.
2. Bumper la version partout d'un coup : `npm run bump 1.0.1` (met à jour `package.json`, `package-lock.json`, `Cargo.toml` et `tauri.conf.json` ; c'est cette dernière que les apps installées comparent au `latest.json`).
3. Commiter et pousser `main` : `git commit -am "Notinger 1.0.1" && git push origin main`.
4. Taguer puis pousser le tag : `git tag v1.0.1 && git push origin v1.0.1` → déclenche la CI.
5. Suivre la CI (`gh run watch`) et vérifier la release publiée : `gh release view v1.0.1 --repo Frybex/notinger-releases`.

Lancer le workflow sans tag (`gh workflow run build.yml`) produit seulement un build de vérification, sans publication.

Secrets nécessaires dans `Frybex/notinger` :

- `TAURI_SIGNING_PRIVATE_KEY` : contenu de `~/.tauri/notinger-updater.key` (signature des artefacts de mise à jour). La clé publique correspondante est dans `tauri.conf.json` → `plugins.updater.pubkey`. Ne jamais régénérer la paire sans publier d'abord une version embarquant la nouvelle clé publique, sinon les apps installées refusent les mises à jour. Conserver une sauvegarde de la clé privée : sans elle, plus aucune mise à jour ne peut être signée.
- `RELEASES_TOKEN` : PAT autorisé à écrire dans `Frybex/notinger-releases` (le `GITHUB_TOKEN` par défaut n'a accès qu'au dépôt où tourne la CI).

Côté app, `src/components/UpdateNotice.tsx` interroge `https://github.com/Frybex/notinger-releases/releases/latest/download/latest.json` au démarrage (après 4 s, échec silencieux si hors ligne) et propose la mise à jour en un clic, avec enregistrement du travail en cours avant redémarrage.
