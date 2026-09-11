import { MessageSquareText, Terminal } from 'lucide-react'
import { Link } from 'react-router'
import { CopyButton } from '@/components/ui/CopyButton'
import { installCommands } from '@/lib/install'

// The onboarding walkthrough, rendered in TWO surfaces: the dashboard's empty sites tab and the
// header HelpButton sheet. Prompt-first on purpose — the product pitch is "your AI writes the
// HTML"; the CLI is plumbing. Every command and prompt is copyable.

// One copyable line: mono text + an icon-only CopyButton. Used for shell commands and AI prompts
// alike so the "grab this" affordance is identical everywhere.
function CopyRow({ text, copiedMessage }: { text: string; copiedMessage: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={text}>
        {text}
      </code>
      <CopyButton text={text} label="" copiedMessage={copiedMessage} variant="ghost" size="icon" className="shrink-0" />
    </div>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono font-semibold text-primary text-xs">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-medium text-sm leading-6">{title}</p>
        {children}
      </div>
    </li>
  )
}

const PROMPTS = [
  'Explain this codebase with an HTML dashboard and publish it to postplan',
  'Turn these notes into a polished HTML page and deploy it to postplan',
]

export function GettingStarted({ onNavigate }: { onNavigate?: () => void } = {}) {
  const commands = installCommands(window.location.origin)
  return (
    <div className="space-y-5">
      <p className="text-muted-foreground text-sm">
        Postplan hosts self-contained HTML your AI builds — ship a page from the terminal, share the link, collect
        comments.
      </p>
      <ol className="space-y-5">
        <Step n={1} title="Install the CLI">
          <CopyRow text={commands.standalone} copiedMessage="Install command copied" />
          <p className="text-muted-foreground text-xs">
            <Terminal className="mr-1 inline size-3 align-[-1px]" />
            Also installs the postplan skill, so Claude Code knows how to deploy here.
          </p>
          <p className="pt-1 font-medium text-muted-foreground text-xs">Or use npm with Node 20+</p>
          <CopyRow text={commands.npm} copiedMessage="npm command copied" />
          <p className="text-muted-foreground text-xs">The npm command also starts sign-in, so skip step 2.</p>
        </Step>
        <Step n={2} title="Sign in">
          <CopyRow text="postplan login" copiedMessage="Command copied" />
        </Step>
        <Step n={3} title="Ask your AI">
          <div className="space-y-2">
            {PROMPTS.map((prompt) => (
              <CopyRow key={prompt} text={prompt} copiedMessage="Prompt copied" />
            ))}
          </div>
          <p className="text-muted-foreground text-xs">
            <MessageSquareText className="mr-1 inline size-3 align-[-1px]" />
            Claude builds the HTML and runs <code className="font-mono">postplan deploy</code> for you — or run it
            yourself on any folder.
          </p>
        </Step>
      </ol>
      <p className="border-t pt-4 text-muted-foreground text-xs">
        No CLI? Drop a folder or a lone HTML file on the dashboard to ship it straight from the browser.
      </p>
      <p className="text-xs">
        <Link to="/docs/api-keys" className="font-medium text-primary hover:underline" onClick={onNavigate}>
          Scripting instead? Set up API keys →
        </Link>
      </p>
    </div>
  )
}
