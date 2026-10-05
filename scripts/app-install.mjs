#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tauriCli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
const updaterKey = join(homedir(), '.tauri', 'notinger-updater.key')

/**
 * Les artefacts de mise à jour sont signés avec la clé de l'updater.
 * Sans la clé (autre machine), le build local se rabat sur une config qui
 * désactive `bundle.createUpdaterArtifacts` : l'installation locale n'a pas
 * besoin de ces artefacts, seule la CI de publication les signe.
 */
function runTauri(args) {
  const hasKey = existsSync(updaterKey)
  const fullArgs = hasKey
    ? args
    : [...args, '--config', '{"bundle":{"createUpdaterArtifacts":false}}']
  console.log(`> tauri ${fullArgs.join(' ')}`)
  execFileSync(process.execPath, [tauriCli, ...fullArgs], {
    stdio: 'inherit',
    cwd: root,
    env: hasKey
      ? { ...process.env, TAURI_SIGNING_PRIVATE_KEY: updaterKey }
      : process.env
  })
}

function installMac() {
  runTauri(['build', '--bundles', 'app'])
  const bundle = join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'Notinger.app')
  const installed = '/Applications/Notinger.app'
  rmSync(installed, { recursive: true, force: true })
  execFileSync('/usr/bin/ditto', [bundle, installed], { stdio: 'inherit' })
  rmSync(bundle, { recursive: true, force: true })
  spawnSync('/usr/bin/killall', ['Dock'], { stdio: 'ignore' })
  console.log('Notinger installé dans /Applications (doublon Launchpad supprimé)')
}

function findSetup() {
  const dir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
  if (!existsSync(dir)) return null
  const setups = readdirSync(dir)
    .filter((name) => name.endsWith('-setup.exe'))
    .sort()
  return setups.length > 0 ? join(dir, setups[setups.length - 1]) : null
}

function registryInstallDir() {
  const result = spawnSync(
    'reg',
    [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Notinger',
      '/v',
      'InstallLocation'
    ],
    { encoding: 'utf8' }
  )
  if (result.status !== 0 || !result.stdout) return null
  const match = result.stdout.match(/InstallLocation\s+REG_SZ\s+(.+)/)
  return match ? match[1].trim().replace(/^"|"$/g, '') : null
}

function installWindows() {
  spawnSync('taskkill', ['/IM', 'Notinger.exe', '/F'], { stdio: 'ignore' })
  runTauri(['build', '--bundles', 'nsis'])
  const setup = findSetup()
  if (!setup) throw new Error('installeur NSIS introuvable après le build')
  console.log(`> ${setup} /S`)
  const installer = spawnSync(setup, ['/S'], { stdio: 'inherit' })
  if (installer.status !== 0) {
    throw new Error(`échec de l'installation (code ${installer.status})`)
  }
  const dir = registryInstallDir() ?? join(process.env.LOCALAPPDATA ?? '', 'Notinger')
  const exe = join(dir, 'Notinger.exe')
  if (!existsSync(exe)) {
    console.error(`Notinger.exe introuvable après installation : ${exe}`)
    process.exit(1)
  }
  const child = spawn(exe, [], { detached: true, stdio: 'ignore' })
  child.unref()
  console.log(`Notinger installé dans ${dir} et lancé`)
}

if (process.platform === 'darwin') {
  installMac()
} else if (process.platform === 'win32') {
  installWindows()
} else {
  console.error('app:install prend en charge macOS et Windows uniquement')
  process.exit(1)
}
