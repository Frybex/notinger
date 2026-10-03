#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

const candidates =
  process.platform === 'win32'
    ? [
        ['py', ['-3']],
        ['python', []],
        ['python3', []]
      ]
    : [
        ['python3', []],
        ['python', []]
      ]

const args = process.argv.slice(2)

for (const [command, prefix] of candidates) {
  const probe = spawnSync(command, [...prefix, '--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32'
  })
  if (probe.status !== 0) continue
  const result = spawnSync(command, [...prefix, ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  process.exit(result.status ?? 1)
}

console.error('Python 3 introuvable (py, python ou python3 requis)')
process.exit(1)
