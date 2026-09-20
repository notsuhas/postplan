import mermaid from 'mermaid'

const style = document.createElement('style')
style.textContent =
  '.postplan-mermaid{margin:1rem 0;overflow:auto}.postplan-mermaid>button{display:block;width:100%;border:0;background:transparent;cursor:zoom-in;padding:1rem}.postplan-mermaid svg{max-width:100%;height:auto}.postplan-diagram-dialog{box-sizing:border-box;width:94vw;max-width:94vw;max-height:90vh;overflow:auto;border:0;border-radius:8px;padding:1rem;background:rgba(255,255,255,1)}.postplan-diagram-dialog::backdrop{background:rgba(0,0,0,.8)}.postplan-diagram-dialog>svg{display:block;width:100%;max-width:none!important;height:auto}.postplan-diagram-dialog>button{display:block;margin:0 0 1rem auto;padding:.5rem 1rem}'
document.head.append(style)

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  maxTextSize: 50_000,
  maxEdges: 500,
  htmlLabels: false,
  secure: [
    'secure',
    'securityLevel',
    'startOnLoad',
    'suppressErrorRendering',
    'maxTextSize',
    'maxEdges',
    'htmlLabels',
    'dompurifyConfig',
    'themeCSS',
  ],
})

async function renderDiagrams() {
  let index = 0
  for (const code of document.querySelectorAll('pre > code.language-mermaid')) {
    const source = code.textContent ?? ''
    const pre = code.parentElement
    if (!pre) continue
    try {
      if (source.length > 50_000) throw new Error('Diagram is too large')
      const { svg } = await mermaid.render(`postplan-diagram-${index++}`, source)
      const figure = document.createElement('figure')
      figure.className = 'postplan-mermaid'
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('aria-label', 'Enlarge diagram')
      // Mermaid sanitizes the SVG under its locked strict security policy.
      button.innerHTML = svg
      button.addEventListener('click', () => {
        const dialog = document.createElement('dialog')
        dialog.className = 'postplan-diagram-dialog'
        dialog.setAttribute('aria-label', 'Enlarged diagram')
        const close = document.createElement('button')
        close.type = 'button'
        close.textContent = 'Close diagram'
        close.addEventListener('click', () => dialog.close())
        dialog.append(close)
        const diagram = button.querySelector('svg')?.cloneNode(true)
        if (diagram) dialog.append(diagram)
        dialog.addEventListener(
          'close',
          () => {
            dialog.remove()
            button.focus()
          },
          { once: true },
        )
        document.body.append(dialog)
        dialog.showModal()
      })
      figure.append(button)
      pre.replaceWith(figure)
    } catch {
      const message = document.createElement('p')
      message.textContent = 'Could not render this Mermaid diagram. Check the source below.'
      pre.before(message)
    }
  }
}

void renderDiagrams()
