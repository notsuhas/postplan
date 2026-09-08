import { parseCliVersion } from './events'

type Semver = [number, number, number]

function parseRelease(value: string): Semver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Fail closed when an instance has opted into a minimum CLI release. */
export function cliNeedsUpgrade(userAgent: string | undefined, minimumVersion: string): boolean {
  const current = parseRelease(parseCliVersion(userAgent) ?? '')
  const minimum = parseRelease(minimumVersion)
  if (!minimum || !current) return true
  for (let i = 0; i < minimum.length; i += 1) {
    if (current[i] !== minimum[i]) return current[i] < minimum[i]
  }
  return false
}
