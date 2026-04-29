import fs from 'node:fs/promises'
import path from 'node:path'

import { defineConfig, type PreviewServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

const apiPort = process.env.PORT
const apiHttpOrigin = process.env.VITE_DOCUMINE_API_HTTP_ORIGIN || process.env.DOCUMINE_API_HTTP_ORIGIN || (apiPort ? `http://localhost:${apiPort}` : '')
const apiWsOrigin = process.env.VITE_DOCUMINE_API_WS_ORIGIN || process.env.DOCUMINE_API_WS_ORIGIN || (apiPort ? `ws://localhost:${apiPort}` : '')
const apiOrigin = apiHttpOrigin || 'http://localhost:3120'
const apiProxy = {
  '/api': apiOrigin,
  '/ws': { target: apiOrigin, ws: true },
}
const webPort = Number(process.env.DOCUMINE_WEB_PORT || 5175)
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

function isUploadedAssetPath(url: string | undefined) {
  return /^\/assets\/[^/]+\/[^/]+$/.test((url || '').split('?')[0] || '')
}

function installUploadedAssetProxyMiddleware(server: ViteDevServer | PreviewServer) {
  server.middlewares.use(async (req, res, next) => {
    if (!isUploadedAssetPath(req.url)) {
      next()
      return
    }

    try {
      const response = await fetch(`${apiOrigin}${req.url}`)
      res.statusCode = response.status
      response.headers.forEach((value, key) => res.setHeader(key, value))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch {
      next()
    }
  })
}

function isDevServer(server: ViteDevServer | PreviewServer): server is ViteDevServer {
  return 'transformIndexHtml' in server
}

async function loadIndexHtml(server: ViteDevServer | PreviewServer, url: string) {
  const indexPath = isDevServer(server)
    ? path.join(server.config.root, 'index.html')
    : path.join(server.config.root, 'dist', 'index.html')
  const indexHtml = await fs.readFile(indexPath, 'utf8')
  return isDevServer(server) ? server.transformIndexHtml(url, indexHtml) : indexHtml
}

function installShareMetadataMiddleware(server: ViteDevServer | PreviewServer) {
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

      const html = await loadIndexHtml(server, req.url || '/')

      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(injectShareMetadata(html, metadata))
    } catch {
      next()
    }
  })
}

export default defineConfig({
  define: {
    'import.meta.env.VITE_DOCUMINE_API_HTTP_ORIGIN': JSON.stringify(apiHttpOrigin),
    'import.meta.env.VITE_DOCUMINE_API_WS_ORIGIN': JSON.stringify(apiWsOrigin),
  },
  plugins: [
    react(),
    {
      name: 'documine-share-metadata',
      configureServer(server) {
        installUploadedAssetProxyMiddleware(server)
        installShareMetadataMiddleware(server)
      },
      configurePreviewServer(server) {
        installUploadedAssetProxyMiddleware(server)
        installShareMetadataMiddleware(server)
      },
    },
  ],
  server: {
    host: '0.0.0.0',
    port: webPort,
    strictPort: true,
    allowedHosts: ['documine.nielpat.cloud'],
    proxy: apiProxy,
  },
  preview: {
    host: '0.0.0.0',
    port: webPort,
    strictPort: true,
    allowedHosts: ['documine.nielpat.cloud'],
    proxy: apiProxy,
  },
})
