import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertPublishableVersion, preparePackages } from '../prepare-packages'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

describe('preparePackages', () => {
  test('stages all native binaries and synchronizes package versions', async () => {
    const root = join(tmpdir(), `postplan-packages-${crypto.randomUUID()}`)
    temporary.push(root)
    const npmDir = join(root, 'npm')
    const distDir = join(root, 'dist')
    await cp(join(import.meta.dir, '../..'), npmDir, { recursive: true })
    await mkdir(distDir, { recursive: true })

    const assets = ['postplan-arm64-darwin', 'postplan-x64-darwin', 'postplan-arm64-linux', 'postplan-x64-linux']
    for (const asset of assets) {
      await writeFile(join(distDir, asset), asset)
      await chmod(join(distDir, asset), 0o755)
    }

    await preparePackages('1.2.0', distDir, npmDir, '1.1.0')

    const launcher = JSON.parse(await readFile(join(npmDir, 'postplan/package.json'), 'utf8'))
    expect(launcher.version).toBe('1.2.0')
    expect(new Set(Object.values(launcher.optionalDependencies))).toEqual(new Set(['1.2.0']))

    for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
      const manifest = JSON.parse(await readFile(join(npmDir, 'platforms', target, 'package.json'), 'utf8'))
      expect(manifest.version).toBe('1.2.0')
      expect(await readFile(join(npmDir, 'platforms', target, 'bin/postplan'), 'utf8')).toContain('postplan-')
      expect((await stat(join(npmDir, 'platforms', target, 'bin/postplan'))).mode & 0o111).not.toBe(0)
    }
  })

  test('rejects versions older than the package currently tagged latest', async () => {
    await expect(preparePackages('1.9.0', '/unused', '/unused', '2.0.0')).rejects.toThrow(
      'cannot be older than npm latest 2.0.0',
    )
  })

  test('allows rerunning the version currently tagged latest', () => {
    expect(() => assertPublishableVersion('2.0.0', '2.0.0')).not.toThrow()
  })
})
