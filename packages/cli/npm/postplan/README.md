# Postplan CLI

Publish a file or folder to a reviewable Postplan URL from any shell-capable coding agent.

```sh
npx @notsuhas/postplan login
npx @notsuhas/postplan deploy ./dist
```

Or install the command globally:

```sh
npm install --global @notsuhas/postplan
postplan login
```

The npm package installs Postplan's native CLI for your current macOS or Linux architecture. For a self-hosted instance, point the CLI at its app origin:

```sh
export POSTPLAN_API_URL=https://postplan.example.com
```

The instance-specific `curl -fsSL <origin>/api/install | sh` installer remains the recommended route for self-hosting because it configures the origin and installs the bundled agent skill automatically.

Source and full documentation: [github.com/notsuhas/postplan](https://github.com/notsuhas/postplan)
