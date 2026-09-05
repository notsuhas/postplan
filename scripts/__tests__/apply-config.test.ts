import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dir, '../..')
const created: string[] = []

function fixture(overrides: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'postplan-config-'))
  created.push(root)
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'packages/web/public'), { recursive: true })
  cpSync(join(projectRoot, 'scripts/apply-config.sh'), join(root, 'scripts/apply-config.sh'))
  cpSync(join(projectRoot, 'wrangler.example.jsonc'), join(root, 'wrangler.example.jsonc'))
  cpSync(join(projectRoot, 'wrangler.content.example.jsonc'), join(root, 'wrangler.content.example.jsonc'))
  cpSync(join(projectRoot, 'packages/web/public/_headers.example'), join(root, 'packages/web/public/_headers.example'))

  const values = {
    APP_URL: 'https://app.example.com',
    CONTENT_URL: 'https://content.example.com',
    SUPERADMIN_EMAILS: 'admin@example.com,second@example.com',
    ORG_EMAIL_DOMAINS: 'example.com',
    D1_DATABASE_ID: '11111111-1111-1111-1111-111111111111',
    KV_NAMESPACE_ID: '22222222222222222222222222222222',
    R2_BUCKET: 'files',
    ...overrides,
  }
  writeFileSync(
    join(root, 'deploy.env'),
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  )
  return root
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true })
})

describe('apply-config.sh', () => {
  test('renders both workers and CSP from deploy.env with safe defaults', () => {
    const root = fixture()
    const result = Bun.spawnSync(['bash', 'scripts/apply-config.sh'], { cwd: root })
    expect(result.exitCode).toBe(0)

    const main = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
    const content = readFileSync(join(root, 'wrangler.content.jsonc'), 'utf8')
    const headers = readFileSync(join(root, 'packages/web/public/_headers'), 'utf8')
    expect(main).toContain('"name": "postplan"')
    expect(main).toContain('"APP_URL": "https://app.example.com"')
    expect(main).toContain('"ORG_EMAIL_DOMAINS": "example.com"')
    expect(main).toContain('"database_name": "postplan-db"')
    expect(main).toContain('"bucket_name": "files"')
    expect(main).toContain('"pattern": "app.example.com"')
    expect(content).toContain('"name": "postplan-content"')
    expect(content).toContain('"pattern": "content.example.com"')
    expect(headers).toContain('https://content.example.com')
    expect(main).toContain('"name": "UPLOAD_LIMITER"')
  })

  test('rejects shared or non-origin URLs', () => {
    for (const overrides of [
      { CONTENT_URL: 'https://app.example.com' },
      { APP_URL: 'http://app.example.com' },
      { APP_URL: 'https://app.example.com/path' },
    ]) {
      const root = fixture(overrides)
      expect(Bun.spawnSync(['bash', 'scripts/apply-config.sh'], { cwd: root }).exitCode).not.toBe(0)
    }
  })

  test('renders from the process environment when deploy.env is absent', () => {
    const root = fixture()
    rmSync(join(root, 'deploy.env'))
    const result = Bun.spawnSync(['bash', 'scripts/apply-config.sh'], {
      cwd: root,
      env: {
        ...process.env,
        APP_URL: 'https://ci.example.com',
        CONTENT_URL: 'https://ci-content.example.com',
        SUPERADMIN_EMAILS: 'admin@example.com',
        ORG_EMAIL_DOMAINS: 'example.com',
        D1_DATABASE_ID: '11111111-1111-1111-1111-111111111111',
        KV_NAMESPACE_ID: '22222222222222222222222222222222',
      },
    })

    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).toContain('https://ci.example.com')
  })
})
