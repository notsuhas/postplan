import { describe, expect, test } from 'bun:test'
import { installCommands } from '../install'

describe('installCommands', () => {
  test('targets both installers at the current Postplan instance', () => {
    expect(installCommands('https://postplan.example.com')).toEqual({
      standalone: 'curl -fsSL https://postplan.example.com/api/install | sh',
      npm: 'POSTPLAN_API_URL=https://postplan.example.com npx @notsuhas/postplan login',
    })
  })

  test('removes a trailing slash before building commands', () => {
    expect(installCommands('https://postplan.example.com/').npm).toBe(
      'POSTPLAN_API_URL=https://postplan.example.com npx @notsuhas/postplan login',
    )
  })
})
