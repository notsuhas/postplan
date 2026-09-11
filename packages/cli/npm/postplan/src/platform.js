import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

const PACKAGES = new Map([
  ['darwin/arm64', '@notsuhas/postplan-darwin-arm64'],
  ['darwin/x64', '@notsuhas/postplan-darwin-x64'],
  ['linux/arm64', '@notsuhas/postplan-linux-arm64'],
  ['linux/x64', '@notsuhas/postplan-linux-x64'],
])

export function packageName(platform, arch) {
  const name = PACKAGES.get(`${platform}/${arch}`)
  if (!name) {
    throw new Error(`Postplan does not support ${platform}/${arch} through npm`)
  }
  return name
}

export function binaryPath(platform, arch, resolve = require.resolve) {
  const manifest = resolve(`${packageName(platform, arch)}/package.json`)
  return join(dirname(manifest), 'bin', 'postplan')
}
