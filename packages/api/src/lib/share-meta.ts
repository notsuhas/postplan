export type ShareMetadata = {
  title: string
  description: string
  url: string
  imageUrl: string
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/** Replace the generic landing-page tags in the controlled Vite shell with artifact-specific tags. */
export function injectShareMetadata(shell: string, metadata: ShareMetadata): string {
  const title = escapeHtml(metadata.title)
  const description = escapeHtml(metadata.description)
  const url = escapeHtml(metadata.url)
  const imageUrl = escapeHtml(metadata.imageUrl)
  const stripped = shell
    .replace(/\s*<title>[\s\S]*?<\/title>/i, '')
    .replace(/\s*<meta\s+(?:name="description"|property="og:(?:type|title|description)")[^>]*>/gi, '')
    .replace(/\s*<meta\s+name="twitter:(?:card|title|description|image)"[^>]*>/gi, '')
  const tags = `
    <title>${title} · Postplan</title>
    <meta name="description" content="${description}" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:image" content="${imageUrl}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${imageUrl}" />
    <link rel="canonical" href="${url}" />`
  return stripped.replace('<head>', `<head>${tags}`)
}
