# AGENTS.md

Notinger : app Tauri v2 (Rust + React/Vite), 100 % locale. Les données vivent dans `~/Documents/Notinger`.

## Après chaque implémentation : rebuild + réinstaller

L'utilisateur teste l'app installée dans `/Applications/Notinger.app`. Les sources modifiées ne sont visibles qu'après un rebuild :

```sh
osascript -e 'quit app "Notinger"' 2>/dev/null; sleep 1
npm run app:install
open /Applications/Notinger.app
```

`npm run app:install` (défini dans `package.json`) build le front + Rust, remplace `/Applications/Notinger.app`, supprime le bundle local généré et fait `killall Dock`.

## Ne jamais créer de doublon

- Ne pas copier/dupliquer l'app à la main (ni dans `/Applications`, ni ailleurs) : un second exemplaire crée un doublon dans le Launchpad.
- Toujours passer par `npm run app:install`, qui remplace l'existant et nettoie le bundle local.
- `npm run app:dev` est réservé au cas où aucune app installée ne tourne : le plugin single-instance fait qu'une seule instance `com.bloem.notinger` peut vivre à la fois.

## Vérifications avant d'installer

```sh
npx tsc --noEmit
cd src-tauri && cargo test
```
