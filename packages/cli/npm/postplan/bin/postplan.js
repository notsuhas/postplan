#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

import { binaryPath, packageName } from '../src/platform.js'

let executable
try {
  executable = binaryPath(process.platform, process.arch)
} catch (error) {
  const target = `${process.platform}/${process.arch}`
  const expected = (() => {
    try {
      return packageName(process.platform, process.arch)
    } catch {
      return null
    }
  })()
  const detail = expected
    ? `The optional package ${expected} is missing. Reinstall @notsuhas/postplan with optional dependencies enabled.`
    : error.message
  console.error(`postplan: ${detail} (${target})`)
  process.exit(1)
}

const result = spawnSync(executable, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, POSTPLAN_MANAGED_BY: 'npm' },
})

if (result.error) {
  console.error(`postplan: could not start the native CLI: ${result.error.message}`)
  process.exit(1)
}
if (result.signal) {
  process.kill(process.pid, result.signal)
}
process.exit(result.status ?? 1)
