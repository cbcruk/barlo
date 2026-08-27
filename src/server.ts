/**
 * The application's HTTP origin, backing Carlo's serving API on `Bun.serve`.
 *
 * Routes are consulted longest-prefix first, and a handler that returns
 * `undefined` falls through to the next one, so a broad
 * {@linkcode AppServer.serveFolder} can sit behind a narrow
 * {@linkcode AppServer.serveHandler}. The server listens on `127.0.0.1` and
 * never on an external interface.
 *
 * @module
 */

import { Result } from 'better-result'
import { stat } from 'node:fs/promises'
import { join, normalize, resolve, sep } from 'node:path'

/**
 * Reserved path serving a blank page, which Chrome opens at launch.
 *
 * Carlo's API registers routes *after* `launch()` returns, so the window needs
 * somewhere harmless to land in the meantime. Handled before user routes and
 * therefore not overridable.
 */
export const BLANK_PATH = '/__barlo/blank'

/**
 * A route handler.
 *
 * Return a `Response` to serve the request, or `undefined` to decline it and
 * let the next route try. Declining is how the fallthrough chain works — a
 * handler that returns a 404 `Response` ends the chain instead.
 */
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

    // A path that cannot be stat'd is not a directory, which is all this asks.
    const isDirectory = (await Result.tryPromise(() => stat(target)))
      .map(s => s.isDirectory())
      .unwrapOr(false)
    const candidates = isDirectory ? [target, join(target, 'index.html')] : [target]

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

/**
 * An in-memory file table, mapping a path to its contents.
 *
 * Keys are relative paths such as `"index.html"` or `"assets/app.js"`, with a
 * leading `./` or `/` tolerated. The content type is inferred from the key's
 * extension, defaulting to `application/octet-stream`.
 */
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

/**
 * The HTTP server behind an {@linkcode App}.
 *
 * Register routes with the `serve*` methods, then {@linkcode AppServer.listen}
 * to bind a port. {@linkcode App} owns an instance and forwards to it, so
 * applications rarely construct one directly.
 */
export class AppServer {
  #routes: Route[] = []
  #server: ReturnType<typeof Bun.serve> | undefined

  /**
   * Serves files from a folder on disk.
   *
   * A request for a directory falls back to its `index.html`. Paths that
   * resolve outside the folder are declined rather than served, so `..`
   * traversal cannot escape.
   *
   * > This reads from disk at request time and therefore does **not** survive
   * > `bun build --compile`, where no folder sits beside the binary. Use
   * > {@linkcode AppServer.serveEmbedded} for compiled applications.
   *
   * @param folder Path to the folder, resolved against the working directory.
   * @param prefix URL prefix to mount it under.
   */
  serveFolder(folder: string, prefix = '/'): void {
    const normalized = normalizePrefix(prefix)
    this.#routes.push({ prefix: normalized, handle: folderHandler(folder, normalized) })
  }

  /**
   * Reverse-proxies a prefix onto a remote origin.
   *
   * Useful for pointing a window at a running dev server so hot reload keeps
   * working. Upstream responses of 500 and above are treated as a failure and
   * fall through to the next route.
   *
   * @param base The origin to proxy to, such as `"http://localhost:5173"`.
   * @param prefix URL prefix to mount it under.
   *
   * @example Wrapping a Vite dev server
   * ```ts
   * import { launch } from "barlo";
   *
   * const app = (await launch()).unwrap();
   *
   * app.serveOrigin("http://localhost:5173");
   * await app.load();
   * ```
   */
  serveOrigin(base: string, prefix = '/'): void {
    const normalized = normalizePrefix(prefix)
    this.#routes.push({ prefix: normalized, handle: originHandler(base, normalized) })
  }

  /**
   * Serves an in-memory file table.
   *
   * The contents live in the bundle rather than on disk, which is what makes
   * this the serving method that survives `bun build --compile`.
   *
   * @param files The paths to serve and their contents.
   * @param prefix URL prefix to mount them under.
   *
   * @example Embedding a page into a compiled binary
   * ```ts
   * import { launch } from "barlo";
   * import index from "./www/index.html" with { type: "text" };
   *
   * const app = (await launch()).unwrap();
   *
   * app.serveEmbedded({ "index.html": index as unknown as string });
   * await app.load("index.html");
   * ```
   *
   * The cast is needed only because Bun types every `.html` import as an
   * `HTMLBundle` for its bundler.
   */
  serveEmbedded(files: EmbeddedFiles, prefix = '/'): void {
    const normalized = normalizePrefix(prefix)
    this.#routes.push({ prefix: normalized, handle: embeddedHandler(files, normalized) })
  }

  /**
   * Registers a handler for any request the other routes decline.
   *
   * Mounted at the root, so it sits behind every prefixed route.
   *
   * @param handler Called with the request; return `undefined` to decline.
   *
   * @example Adding a JSON endpoint
   * ```ts
   * import { launch } from "barlo";
   *
   * const app = (await launch()).unwrap();
   *
   * app.serveHandler(request =>
   *   new URL(request.url).pathname === "/api/time"
   *     ? Response.json({ now: Date.now() })
   *     : undefined,
   * );
   * ```
   */
  serveHandler(handler: RequestHandler): void {
    this.#routes.push({ prefix: '/', handle: handler })
  }

  /**
   * Binds an ephemeral port on `127.0.0.1` and starts serving.
   *
   * Idempotent: calling it again returns the origin already in use. Routes may
   * be registered before or after this call, since they are resolved per
   * request.
   *
   * @returns The origin now being served, such as `"http://127.0.0.1:53124"`.
   */
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

  /**
   * The origin currently being served.
   *
   * Only reachable after {@linkcode AppServer.listen}, which every {@linkcode App}
   * calls during startup, so this is a programming error rather than a runtime
   * failure and stays an exception.
   *
   * @throws When the server is not listening.
   */
  get origin(): string {
    if (!this.#server) throw new Error('Server is not listening')
    return `http://127.0.0.1:${this.#server.port}`
  }

  /**
   * Stops the server and closes open connections.
   *
   * Registered routes are kept, so a later {@linkcode AppServer.listen} starts
   * serving them again on a new port. Idempotent.
   */
  stop(): void {
    this.#server?.stop(true)
    this.#server = undefined
  }
}
