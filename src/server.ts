/**
 * The app's origin. Carlo's serveFolder/serveOrigin/serveHandler, on Bun.serve.
 */

import { stat } from 'node:fs/promises'
import { join, normalize, resolve, sep } from 'node:path'

/** Reserved path Chrome opens at launch, before any route is registered. */
export const BLANK_PATH = '/__barlo/blank'

export type RequestHandler = (request: Request) => Response | undefined | Promise<Response | undefined>

interface Route {
  prefix: string
  handle: RequestHandler
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/g, '')
  return trimmed ? `/${trimmed}/` : '/'
}

/** Serve files from disk, refusing anything that escapes the folder. */
function folderHandler(folder: string, prefix: string): RequestHandler {
  const root = resolve(folder)

  return async request => {
    const pathname = decodeURIComponent(new URL(request.url).pathname)
    if (!pathname.startsWith(prefix)) return undefined

    const relative = pathname.slice(prefix.length) || 'index.html'
    const target = resolve(root, normalize(relative))
    if (target !== root && !target.startsWith(root + sep)) return undefined

    const candidates = [target]
    try {
      if ((await stat(target)).isDirectory()) candidates.push(join(target, 'index.html'))
    } catch {}

    for (const candidate of candidates) {
      const file = Bun.file(candidate)
      if (await file.exists()) return new Response(file)
    }
    return undefined
  }
}

/** Reverse-proxy a prefix onto a remote origin (Carlo's serveOrigin). */
function originHandler(base: string, prefix: string): RequestHandler {
  return async request => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith(prefix)) return undefined

    const upstream = new URL(url.pathname.slice(prefix.length) + url.search, base)
    const response = await fetch(upstream, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // @ts-expect-error -- Bun supports duplex for streaming request bodies
      duplex: 'half',
    })
    return response.ok || response.status < 500 ? response : undefined
  }
}

export type EmbeddedFiles = Record<string, string | Uint8Array | ArrayBuffer | Blob>

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
}

function embeddedHandler(files: EmbeddedFiles, prefix: string): RequestHandler {
  const table = new Map(
    Object.entries(files).map(([name, body]) => [name.replace(/^\.?\//, ''), body]),
  )

  return request => {
    const pathname = decodeURIComponent(new URL(request.url).pathname)
    if (!pathname.startsWith(prefix)) return undefined

    const key = pathname.slice(prefix.length) || 'index.html'
    const body = table.get(key) ?? table.get(`${key}/index.html`.replace(/^\//, ''))
    if (body === undefined) return undefined

    const type = MIME[key.split('.').pop() ?? ''] ?? 'application/octet-stream'
    return new Response(body as BodyInit, { headers: { 'content-type': type } })
  }
}

export class AppServer {
  #routes: Route[] = []
  #server: ReturnType<typeof Bun.serve> | undefined

  serveFolder(folder: string, prefix = '/'): void {
    const normalized = normalizePrefix(prefix)
    this.#routes.push({ prefix: normalized, handle: folderHandler(folder, normalized) })
  }

  serveOrigin(base: string, prefix = '/'): void {
    const normalized = normalizePrefix(prefix)
    this.#routes.push({ prefix: normalized, handle: originHandler(base, normalized) })
  }

  serveEmbedded(files: EmbeddedFiles, prefix = '/'): void {
    const normalized = normalizePrefix(prefix)
    this.#routes.push({ prefix: normalized, handle: embeddedHandler(files, normalized) })
  }

  serveHandler(handler: RequestHandler): void {
    this.#routes.push({ prefix: '/', handle: handler })
  }

  listen(): string {
    if (this.#server) return this.origin

    // Later routes are more specific, and longer prefixes should win.
    const ordered = () => [...this.#routes].sort((a, b) => b.prefix.length - a.prefix.length)

    this.#server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async request => {
        // Chrome needs somewhere to land before the app registers its routes.
        if (new URL(request.url).pathname === BLANK_PATH)
          return new Response('<!doctype html><meta charset=utf-8><title></title>', {
            headers: { 'content-type': 'text/html' },
          })

        for (const route of ordered()) {
          const response = await route.handle(request)
          if (response) return response
        }
        return new Response('Not found', { status: 404 })
      },
    })
    return this.origin
  }

  get origin(): string {
    if (!this.#server) throw new Error('Server is not listening')
    return `http://127.0.0.1:${this.#server.port}`
  }

  stop(): void {
    this.#server?.stop(true)
    this.#server = undefined
  }
}
