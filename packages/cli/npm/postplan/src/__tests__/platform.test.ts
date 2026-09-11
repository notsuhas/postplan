import { describe, expect, test } from 'bun:test'
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { binaryPath, packageName } from '../platform.js'

describe('packageName', () => {
  test.each([
    ['darwin', 'arm64', '@notsuhas/postplan-darwin-arm64'],
    ['darwin', 'x64', '@notsuhas/postplan-darwin-x64'],
    ['linux', 'arm64', '@notsuhas/postplan-linux-arm64'],
    ['linux', 'x64', '@notsuhas/postplan-linux-x64'],
  ])('maps %s/%s to its native package', (platform, arch, expected) => {
    expect(packageName(platform, arch)).toBe(expected)
  })

  test('rejects unsupported platforms', () => {
    expect(() => packageName('win32', 'x64')).toThrow('Postplan does not support win32/x64 through npm')
  })
})

test('binaryPath resolves the executable through the platform package', () => {
  expect(binaryPath('linux', 'x64', () => '/packages/native/package.json')).toBe('/packages/native/bin/postplan')
})

async function launcherFixture(nativeScript?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'postplan-launcher-'))
  await mkdir(join(dir, 'bin'), { recursive: true })
  await mkdir(join(dir, 'src'), { recursive: true })
  await cp(new URL('../../bin/postplan.js', import.meta.url), join(dir, 'bin/postplan.js'))
  await cp(new URL('../platform.js', import.meta.url), join(dir, 'src/platform.js'))

  if (nativeScript && process.platform === 'linux' && process.arch === 'x64') {
    const packageDir = join(dir, 'node_modules/@notsuhas/postplan-linux-x64')
    await mkdir(join(packageDir, 'bin'), { recursive: true })
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: '@notsuhas/postplan-linux-x64', version: '1.2.0' }),
    )
    const native = join(packageDir, 'bin/postplan')
    await writeFile(native, nativeScript)
    await chmod(native, 0o755)
  }

  return {
    command: join(dir, 'bin/postplan.js'),
    cleanup: () => rm(dir, { force: true, recursive: true }),
  }
}

test('launcher forwards arguments, environment, and exit status', async () => {
  if (process.platform !== 'linux' || process.arch !== 'x64') return

  const fixture = await launcherFixture('#!/bin/sh\nprintf "%s\\n" "$POSTPLAN_MANAGED_BY:$1:$2"\nexit 7\n')

  try {
    const result = Bun.spawnSync(['node', fixture.command, 'deploy', 'my site'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.stdout.toString()).toBe('npm:deploy:my site\n')
    expect(result.exitCode).toBe(7)
  } finally {
    await fixture.cleanup()
  }
})

test('launcher explains when the optional native package is missing', async () => {
  if (process.platform !== 'linux' || process.arch !== 'x64') return

  const fixture = await launcherFixture()
  try {
    const result = Bun.spawnSync(['node', fixture.command, 'version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('The optional package @notsuhas/postplan-linux-x64 is missing')
  } finally {
    await fixture.cleanup()
  }
})
