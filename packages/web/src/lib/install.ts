export function installCommands(origin: string) {
  const instance = origin.replace(/\/+$/, '')
  return {
    standalone: `curl -fsSL ${instance}/api/install | sh`,
    npm: `POSTPLAN_API_URL=${instance} npx @notsuhas/postplan login`,
  }
}
