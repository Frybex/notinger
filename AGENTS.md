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

Une release est déclenchée par un tag `v*` : la CI construit macOS (Apple Silicon) et Windows, signe les artefacts de mise à jour et publie le tout dans ce même dépôt **public** `Frybex/notinger` (installeurs + `latest.json`).

1. Vérifier le code : `npx tsc --noEmit` et `cargo test --manifest-path src-tauri/Cargo.toml`.
2. Bumper la version partout d'un coup : `npm run bump 1.0.1` (met à jour `package.json`, `package-lock.json`, `Cargo.toml` et `tauri.conf.json` ; c'est cette dernière que les apps installées comparent au `latest.json`).
3. Commiter et pousser `main` : `git commit -am "Notinger 1.0.1" && git push origin main`.
4. Taguer puis pousser le tag : `git tag v1.0.1 && git push origin v1.0.1` → déclenche la CI.
5. Suivre la CI (`gh run watch`) et vérifier la release publiée : `gh release view v1.0.1 --repo Frybex/notinger`.

Lancer le workflow sans tag (`gh workflow run build.yml`) produit seulement un build de vérification, sans publication.

Secret nécessaire dans `Frybex/notinger` :

- `TAURI_SIGNING_PRIVATE_KEY` : contenu de `~/.tauri/notinger-updater.key` (signature des artefacts de mise à jour). La clé publique correspondante est dans `tauri.conf.json` → `plugins.updater.pubkey`. Ne jamais régénérer la paire sans publier d'abord une version embarquant la nouvelle clé publique, sinon les apps installées refusent les mises à jour. Conserver une sauvegarde de la clé privée : sans elle, plus aucune mise à jour ne peut être signée.

Migration : les versions ≤ 1.0.2 interrogent encore `Frybex/notinger-releases`. Ce dépôt est conservé pour elles ; les nouvelles versions interrogent `Frybex/notinger`.

Côté app, `src/components/UpdateNotice.tsx` interroge `https://github.com/Frybex/notinger/releases/latest/download/latest.json` au démarrage (après 4 s, échec silencieux si hors ligne) et propose la mise à jour en un clic, avec enregistrement du travail en cours avant redémarrage.

Signature macOS : `src-tauri/tauri.conf.json` → `bundle.macOS.signingIdentity: "-"` signe l'app en ad-hoc. Sans elle, un DMG téléchargé est mis en quarantaine par Gatekeeper et macOS affiche « l'application est endommagée » sur Apple Silicon. Ne pas retirer cette ligne ; la signature ad-hoc n'empêche pas macOS de demander une validation manuelle au premier lancement (voir README).
