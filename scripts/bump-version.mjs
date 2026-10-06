#!/usr/bin/env node
// Met à jour la version de l'application partout où elle est déclarée :
// package.json, package-lock.json, src-tauri/Cargo.toml et
// src-tauri/tauri.conf.json (c'est cette dernière que l'updater compare au
// latest.json publié sur Frybex/notinger).
// Usage : npm run bump 1.0.1
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = process.argv[2]

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage : npm run bump <x.y.z>   (ex. npm run bump 1.0.1)')
  process.exit(1)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`)
}

const packagePath = join(root, 'package.json')
const packageJson = readJson(packagePath)
packageJson.version = version
writeJson(packagePath, packageJson)

const lockPath = join(root, 'package-lock.json')
const lock = readJson(lockPath)
lock.version = version
if (lock.packages && lock.packages['']) lock.packages[''].version = version
writeJson(lockPath, lock)

// Dans Cargo.toml, la première ligne `version = "…"` est celle du bloc
// [package] ; celles des dépendances utilisent des contraintes (ex. "2").
const cargoPath = join(root, 'src-tauri', 'Cargo.toml')
const cargo = readFileSync(cargoPath, 'utf8')
const cargoNext = cargo.replace(/^version = "[^"]*"$/m, `version = "${version}"`)
if (cargoNext === cargo) {
  console.error('version introuvable dans src-tauri/Cargo.toml')
  process.exit(1)
}
writeFileSync(cargoPath, cargoNext)

const confPath = join(root, 'src-tauri', 'tauri.conf.json')
const conf = readJson(confPath)
conf.version = version
writeJson(confPath, conf)

console.log(`Version ${version} mise à jour.`)
console.log(`Publier : git commit -am "Notinger ${version}" && git tag v${version} && git push origin main --tags`)
