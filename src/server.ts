/**
 * The application's HTTP origin, backing Carlo's serving API on `node:http`.
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
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

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

/**
 * The request's decoded pathname, or `undefined` when it cannot be decoded.
 *
 * `decodeURIComponent` throws on malformed percent-encoding — `/%ZZ` is enough
 * — and a path barlo cannot decode is one it cannot be serving, so the route
 * declines rather than taking the response down with it.
 */
function decodedPath(request: Request): string | undefined {
  return Result.try({
    try: () => decodeURIComponent(new URL(request.url).pathname),
    catch: () => undefined,
  }).unwrapOr(undefined)
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/g, '')
  return trimmed ? `/${trimmed}/` : '/'
}

/** Serve files from disk, refusing anything that escapes the folder. */
function folderHandler(folder: string, prefix: string): RequestHandler {
  const root = resolve(folder)

  return async request => {
    const pathname = decodedPath(request)
    if (pathname === undefined || !pathname.startsWith(prefix)) return undefined

    const relative = pathname.slice(prefix.length) || 'index.html'
    const target = resolve(root, normalize(relative))
    if (target !== root && !target.startsWith(root + sep)) return undefined

    // A path that cannot be stat'd is not a directory, which is all this asks.
    const isDirectory = (await Result.tryPromise(() => stat(target)))
      .map(s => s.isDirectory())
      .unwrapOr(false)
    const candidates = isDirectory ? [target, join(target, 'index.html')] : [target]

    for (const candidate of candidates) {
      // An unreadable file is one this route cannot serve, same as a missing one.
      const found = await Result.tryPromise(() => stat(candidate))
      if (found.isErr() || !found.value.isFile()) continue

      // Module scripts are refused without a JavaScript MIME type, so the type
      // is inferred here as it is for embedded files.
      const body = Readable.toWeb(createReadStream(candidate)) as ReadableStream
      return new Response(body, {
        headers: {
          'content-type': mimeType(candidate),
          'content-length': String(found.value.size),
        },
      })
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

    // An upstream that is not listening is the ordinary case here — the app
    // usually starts before the dev server it proxies — so a refused connection
    // declines like a 5xx does rather than failing the request.
    const proxied = await Result.tryPromise(() =>
      fetch(upstream, {
        method: request.method,
        headers: forwardable(request.headers),
        body: request.body,
        // Required by Node's fetch for a streamed request body.
        duplex: 'half',
      } as RequestInit),
    )
    if (proxied.isErr()) return undefined

    const response = proxied.unwrap()
    if (!response.ok && response.status >= 500) return undefined

    // fetch has already decompressed the body, so the upstream's encoding and
    // length no longer describe it; passed on, the window would decode twice.
    const headers = new Headers(response.headers)
    headers.delete('content-encoding')
    headers.delete('content-length')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

/**
 * Headers that describe one connection rather than the request, which Node's
 * fetch refuses outright, plus `host`, which must name the upstream.
 */
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'te', 'trailer']

function forwardable(headers: Headers): Headers {
  const copy = new Headers(headers)
  for (const name of HOP_BY_HOP) copy.delete(name)
  return copy
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
  ico: 'image/x-icon',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
}

function mimeType(path: string): string {
  return MIME[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream'
}

function embeddedHandler(files: EmbeddedFiles, prefix: string): RequestHandler {
  const table = new Map(
    Object.entries(files).map(([name, body]) => [name.replace(/^\.?\//, ''), body]),
  )

  return request => {
    const pathname = decodedPath(request)
    if (pathname === undefined || !pathname.startsWith(prefix)) return undefined

    const key = pathname.slice(prefix.length) || 'index.html'
    const body = table.get(key) ?? table.get(`${key}/index.html`.replace(/^\//, ''))
    if (body === undefined) return undefined

    return new Response(body as BodyInit, { headers: { 'content-type': mimeType(key) } })
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
  #server: Server | undefined
  #port = 0
  #listening: Promise<string> | undefined

  /**
   * Serves files from a folder on disk.
   *
   * A request for a directory falls back to its `index.html`. Paths that
   * resolve outside the folder are declined rather than served, so `..`
   * traversal cannot escape.
   *
   * Content types are inferred from the extension, as for
   * {@linkcode AppServer.serveEmbedded}, and files are streamed rather than
   * read into memory.
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
   * working. Upstream responses of 500 and above fall through to the next
   * route, and so does an upstream that cannot be reached at all — starting the
   * app before its dev server is ordinary rather than an error.
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
   * The contents live in memory rather than on disk, which suits pages
   * generated at runtime or inlined by a bundler. See
   * {@linkcode App.serveEmbedded} for an example.
   *
   * @param files The paths to serve and their contents.
   * @param prefix URL prefix to mount them under.
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
   * A handler that throws is a bug rather than a decline, so it answers 500 and
   * logs, instead of letting the exception reach the window as an error page.
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
   * Rejects when the port cannot be bound.
   */
  listen(): Promise<string> {
    this.#listening ??= this.#bind().catch((cause: unknown) => {
      this.#listening = undefined
      throw cause
    })
    return this.#listening
  }

  async #bind(): Promise<string> {
    const server = createServer((req, res) => void this.#serve(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.#server = server
    this.#port = (server.address() as AddressInfo).port
    return this.origin
  }

  async #serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A window that goes away mid-response aborts whatever is still producing
    // it, such as a proxied upstream request.
    const controller = new AbortController()
    res.once('close', () => {
      if (!res.writableFinished) controller.abort()
    })

    const request = Result.try(() => toRequest(req, this.origin, controller.signal))
    const response = request.isOk()
      ? await this.#respond(request.value)
      : new Response('Bad request', { status: 400 })
    await send(response, req, res)
  }

  async #respond(request: Request): Promise<Response> {
    // Chrome needs somewhere to land before the app registers its routes.
    if (new URL(request.url).pathname === BLANK_PATH)
      return new Response('<!doctype html><meta charset=utf-8><title></title>', {
        headers: { 'content-type': 'text/html' },
      })

    // Later routes are more specific, and longer prefixes should win.
    const ordered = [...this.#routes].sort((a, b) => b.prefix.length - a.prefix.length)

    for (const route of ordered) {
      const handled = await Result.tryPromise({
        try: async () => route.handle(request),
        catch: (cause) => cause,
      })
      if (handled.isErr()) {
        // A handler that throws is a bug in the handler, not a decline. Saying
        // so beats a dropped connection, which leaves the window on an error
        // page with no clue which handler failed.
        console.error(
          `barlo: the handler for ${route.prefix} threw on ${request.url}:`,
          handled.error,
        )
        return new Response('Internal error', { status: 500 })
      }
      const response = handled.unwrap()
      if (response) return response
    }
    return new Response('Not found', { status: 404 })
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
    return `http://127.0.0.1:${this.#port}`
  }

  /**
   * Stops the server and closes open connections.
   *
   * Registered routes are kept, so a later {@linkcode AppServer.listen} starts
   * serving them again on a new port. Idempotent.
   */
  stop(): void {
    // Nothing useful follows a server that will not stop; it is going away.
    const server = this.#server
    if (server) {
      Result.try({
        try: () => {
          server.close()
          server.closeAllConnections()
        },
        catch: () => undefined,
      })
    }
    this.#server = undefined
    this.#listening = undefined
  }
}

/**
 * Converts Node's request into a fetch `Request`, which is what route handlers
 * take.
 *
 * The URL is joined rather than resolved: `new URL("//host/x", origin)` would
 * read the path as another host.
 */
function toRequest(req: IncomingMessage, origin: string, signal: AbortSignal): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one)
  }
  const method = req.method ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD'
  return new Request(new URL(`${origin}${req.url ?? '/'}`), {
    method,
    headers,
    signal,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    // Required by Node's fetch for a streamed request body.
    duplex: 'half',
  } as RequestInit)
}

/** Writes a fetch `Response` out through Node's response. */
async function send(response: Response, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value
  })
  // Several cookies cannot share one header line, so they go out as a list.
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) headers['set-cookie'] = cookies

  if (response.statusText) res.writeHead(response.status, response.statusText, headers)
  else res.writeHead(response.status, headers)

  if (!response.body || req.method === 'HEAD') {
    await response.body?.cancel()
    res.end()
    return
  }
  // A window that navigates away mid-response closes the socket. That ends
  // this response, not the server, so the broken pipe is not an error.
  await Result.tryPromise(() =>
    pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res),
  )
}
