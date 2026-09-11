import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TARGETS = [
  {
    directory: 'darwin-arm64',
    asset: 'postplan-arm64-darwin',
    package: '@notsuhas/postplan-darwin-arm64',
  },
  {
    directory: 'darwin-x64',
    asset: 'postplan-x64-darwin',
    package: '@notsuhas/postplan-darwin-x64',
  },
  {
    directory: 'linux-arm64',
    asset: 'postplan-arm64-linux',
    package: '@notsuhas/postplan-linux-arm64',
  },
  {
    directory: 'linux-x64',
    asset: 'postplan-x64-linux',
    package: '@notsuhas/postplan-linux-x64',
  },
] as const

function parseStableVersion(version: string): [number, number, number] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)
  if (!match) throw new Error(`invalid stable npm version: ${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function assertPublishableVersion(version: string) {
  const parts = parseStableVersion(version)
  const minimum: [number, number, number] = [1, 2, 0]
  const isOld = parts.some((part, index) => {
    if (part === minimum[index]) return false
    return parts.slice(0, index).every((value, prefix) => value === minimum[prefix]) && part < minimum[index]
  })
  if (isOld) throw new Error(`npm version ${version} must be at least 1.2.0`)
}

async function readManifest(path: string) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeManifest(path: string, manifest: Record<string, unknown>) {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

export async function preparePackages(version: string, distDir: string, npmDir: string) {
  assertPublishableVersion(version)

  for (const target of TARGETS) {
    const packageDir = join(npmDir, 'platforms', target.directory)
    const manifestPath = join(packageDir, 'package.json')
    const manifest = await readManifest(manifestPath)
    manifest.version = version
    await writeManifest(manifestPath, manifest)

    const binDir = join(packageDir, 'bin')
    const executable = join(binDir, 'postplan')
    await mkdir(binDir, { recursive: true })
    await copyFile(join(distDir, target.asset), executable)
    await chmod(executable, 0o755)
  }

  const launcherPath = join(npmDir, 'postplan', 'package.json')
  const launcher = await readManifest(launcherPath)
  launcher.version = version
  launcher.optionalDependencies = Object.fromEntries(TARGETS.map((target) => [target.package, version]))
  await writeManifest(launcherPath, launcher)
}

if (import.meta.main) {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const npmDir = resolve(scriptDir, '..')
  const version = Bun.argv[2]
  const distDir = resolve(Bun.argv[3] ?? join(npmDir, '..', 'dist'))
  if (!version) throw new Error('usage: prepare-packages.ts <version> [dist-dir]')
  await preparePackages(version, distDir, npmDir)
  console.log(`Prepared Postplan npm packages at ${version}`)
}
