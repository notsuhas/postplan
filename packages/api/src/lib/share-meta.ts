export type ShareMetadata = {
  title: string
  description: string
  url: string
  imageUrl: string
  contentUrl: string
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

export function contentAlternateLink(contentUrl: string): string {
  return `<${contentUrl}>; rel="alternate"; type="text/html"`
}

/** Replace the generic landing-page tags in the controlled Vite shell with artifact-specific tags. */
export function injectShareMetadata(shell: string, metadata: ShareMetadata): string {
  const title = escapeHtml(metadata.title)
  const description = escapeHtml(metadata.description)
  const url = escapeHtml(metadata.url)
  const imageUrl = escapeHtml(metadata.imageUrl)
  const contentUrl = escapeHtml(metadata.contentUrl)
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
    <link rel="canonical" href="${url}" />
    <link rel="alternate" type="text/html" href="${contentUrl}" title="Artifact content" />`
  const fallback = `<main data-postplan-share-fallback><h1>${title}</h1><p>${description}</p><p><a href="${contentUrl}">Read the artifact content</a></p></main>`
  return stripped
    .replace('<head>', `<head>${tags}`)
    .replace('<div id="root"></div>', `<div id="root">${fallback}</div>`)
}
