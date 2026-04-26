import fs from 'node:fs/promises'
import path from 'node:path'

import { defineConfig, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

const apiOrigin = process.env.DOCUMINE_API_HTTP_ORIGIN || 'http://localhost:3120'
const documineTitle = 'Documine'
const documineDescription = 'Shared markdown note'

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function injectShareMetadata(html: string, metadata: { title: string; url: string }) {
  const title = escapeHtml(metadata.title || documineTitle)
  const url = escapeHtml(metadata.url)
  const description = escapeHtml(documineDescription)
  const tags = [
    `<title>${title}</title>`,
    `<meta property="og:site_name" content="Documine" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
  ].join('\n    ')

  return html
    .replace(/<meta property="og:[^"]+" content="[^"]*" \/>\n\s*/g, '')
    .replace(/<meta name="twitter:[^"]+" content="[^"]*" \/>\n\s*/g, '')
    .replace(/<title>.*?<\/title>/s, tags)
}

async function loadShareMetadata(shareId: string, publicUrl: string) {
  const response = await fetch(`${apiOrigin}/api/share/${encodeURIComponent(shareId)}/meta`)
  if (!response.ok) {
    return null
  }
  const payload = await response.json() as { title?: string }
  return {
    title: payload.title || documineTitle,
    url: publicUrl,
  }
}

function shareIdFromUrl(url: string | undefined) {
  const pathname = (url || '').split('?')[0] || ''
  const match = pathname.match(/^\/s\/([^/]+)$/)
  return match ? decodeURIComponent(match[1]) : null
}

function installShareMetadataMiddleware(server: ViteDevServer) {
  server.middlewares.use(async (req, res, next) => {
    const shareId = shareIdFromUrl(req.url)
    if (!shareId) {
      next()
      return
    }

    try {
      const host = req.headers.host || 'localhost'
      const protocol = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0]
      const publicUrl = `${protocol}://${host}/s/${encodeURIComponent(shareId)}`
      const metadata = await loadShareMetadata(shareId, publicUrl)
      if (!metadata) {
        next()
        return
      }

      const indexPath = path.join(server.config.root, 'index.html')
      const indexHtml = await fs.readFile(indexPath, 'utf8')
      const html = await server.transformIndexHtml(req.url || '/', indexHtml)

      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(injectShareMetadata(html, metadata))
    } catch {
      next()
    }
  })
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'documine-share-metadata',
      configureServer: installShareMetadataMiddleware,
    },
  ],
  server: {
    host: '0.0.0.0',
    port: 5175,
    strictPort: true,
    allowedHosts: ['documine.nielpat.cloud'],
  },
  preview: {
    host: '0.0.0.0',
    port: 5175,
    strictPort: true,
    allowedHosts: ['documine.nielpat.cloud'],
  },
})
