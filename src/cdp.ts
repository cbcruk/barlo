/**
 * Minimal Chrome DevTools Protocol client over a WebSocket.
 *
 * Carlo leaned on Puppeteer for this; Bun ships a WebSocket client, so the
 * whole transport is a few dozen lines and barlo stays dependency-free.
 *
 * Sessions are flattened: one socket carries the browser-level connection and
 * every attached target, distinguished by `sessionId`. This module is internal
 * plumbing for {@linkcode App} and {@linkcode Window}.
 *
 * @module
 */

import { Result } from 'better-result'

import { BrowserGoneError, ProtocolError } from './errors'

/** What a CDP command can fail with. */
export type SendError = ProtocolError | BrowserGoneError

type Handler = (params: any) => void

interface Pending {
  /** Kept so a dropped connection can say which command it lost. */
  method: string
  succeed: (value: any) => void
  fail: (error: SendError) => void
}

/**
 * A CDP command and event scope: either the browser itself or one attached
 * target.
 *
 * Commands sent through a session are answered by whatever it is scoped to, so
 * page-domain commands need a target session while browser-domain commands
 * such as `Browser.setWindowBounds` need {@linkcode CDPConnection.browser}.
 */
export class CDPSession {
  /**
   * The session's CDP identifier, or `undefined` for the browser-level
   * session, whose messages carry no `sessionId`.
   */
  readonly sessionId: string | undefined
  #connection: CDPConnection
  #handlers = new Map<string, Set<Handler>>()

  /**
   * Creates a session. Called by {@linkcode CDPConnection}; not useful
   * directly, since a session must be registered with its connection to
   * receive events.
   *
   * @param connection The connection carrying this session's messages.
   * @param sessionId The attached target's identifier, omitted for the
   * browser-level session.
   */
  constructor(connection: CDPConnection, sessionId?: string) {
    this.#connection = connection
    this.sessionId = sessionId
  }

  /**
   * Sends a CDP command and resolves with its result.
   *
   * @template T The shape of the command's result object.
   * @param method A domain-qualified method name, such as `"Page.navigate"`.
   * @param params The command's parameters. Must be JSON-serializable.
   * @returns The command's `result` object, {@linkcode ProtocolError} when
   * Chrome refuses it, or {@linkcode BrowserGoneError} when the connection
   * closes while it is in flight.
   *
   * @example Reading the page title
   * ```ts
   * import { launch } from "barlo";
   *
   * const app = (await launch()).unwrap();
   *
   * const session = app.mainWindow().unwrap().session;
   *
   * const sent = await session.send("Runtime.evaluate", {
   *   expression: "document.title",
   *   returnByValue: true,
   * });
   * const title = sent.map((r) => r.result.value).unwrapOr("");
   * ```
   */
  send<T = any>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Result<T, SendError>> {
    return this.#connection._send(method, params, this.sessionId)
  }

  /**
   * Subscribes to a CDP event on this session.
   *
   * @param event A domain-qualified event name, such as
   * `"Runtime.bindingCalled"`.
   * @param handler Called with the event's parameters.
   * @returns A function that removes the subscription.
   */
  on(event: string, handler: Handler): () => void {
    let set = this.#handlers.get(event)
    if (!set) this.#handlers.set(event, (set = new Set()))
    set.add(handler)
    return () => set!.delete(handler)
  }

  /** @internal */
  _emit(event: string, params: any): void {
    for (const handler of this.#handlers.get(event) ?? []) handler(params)
  }

  /**
   * Attaches to a target and returns a session scoped to it.
   *
   * Only meaningful on the browser-level session. Attaching twice to the same
   * target returns the same {@linkcode CDPSession}.
   *
   * @param targetId The target to attach to, from `Target.getTargets`.
   * @returns A session whose commands and events belong to that target, or why
   * the attach failed.
   */
  async attach(targetId: string): Promise<Result<CDPSession, SendError>> {
    const attached = await this.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    return attached.map(({ sessionId }) => this.#connection._register(sessionId))
  }
}

/**
 * A live WebSocket connection to Chrome's DevTools endpoint.
 *
 * Owns the socket, the request/response correlation, and the session table.
 * When the socket closes, every in-flight command comes back as
 * {@linkcode BrowserGoneError} and `"__disconnected__"` is emitted on
 * {@linkcode CDPConnection.browser}, which is how {@linkcode App} learns that
 * Chrome went away.
 */
export class CDPConnection {
  #socket: WebSocket
  #nextId = 0
  #pending = new Map<number, Pending>()
  #sessions = new Map<string, CDPSession>()
  #closed = false

  /**
   * The browser-level session, for `Browser.*` and `Target.*` commands and for
   * the synthetic `"__disconnected__"` event.
   */
  readonly browser: CDPSession

  private constructor(socket: WebSocket) {
    this.#socket = socket
    this.browser = new CDPSession(this)

    socket.onmessage = event => this.#dispatch(String(event.data))
    socket.onclose = () => this.#abort(new Error('CDP connection closed'))
    socket.onerror = () => this.#abort(new Error('CDP connection errored'))
  }

  /**
   * Opens a connection to a DevTools WebSocket endpoint.
   *
   * The endpoint URL comes from the `DevToolsActivePort` file Chrome writes
   * into its profile directory.
   *
   * @param url A `ws://` DevTools browser endpoint.
   * @param signal Aborts the attempt while the socket is still opening.
   * @returns A connection whose socket is open and ready for commands, or why
   * the handshake did not complete.
   */
  static async connect(
    url: string,
    signal?: AbortSignal,
  ): Promise<Result<CDPConnection, BrowserGoneError>> {
    const socket = new WebSocket(url)
    const opened = await new Promise<Result<void, BrowserGoneError>>(resolve => {
      socket.onopen = () => resolve(Result.ok())
      socket.onerror = () =>
        resolve(Result.err(new BrowserGoneError({ message: `could not connect to ${url}` })))
      signal?.addEventListener(
        'abort',
        () => resolve(Result.err(new BrowserGoneError({ message: `connecting to ${url} was aborted` }))),
        { once: true },
      )
    })
    if (opened.isErr()) {
      socket.close()
      return opened
    }
    return Result.ok(new CDPConnection(socket))
  }

  /** @internal */
  _register(sessionId: string): CDPSession {
    let session = this.#sessions.get(sessionId)
    if (!session) this.#sessions.set(sessionId, (session = new CDPSession(this, sessionId)))
    return session
  }

  /** @internal */
  _send(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Result<any, SendError>> {
    if (this.#closed) {
      return Promise.resolve(
        Result.err(new BrowserGoneError({ message: `${method}: the connection is closed` })),
      )
    }
    const id = ++this.#nextId
    const message: Record<string, unknown> = { id, method, params }
    if (sessionId) message.sessionId = sessionId

    // Every rejection path is turned into an Err here, so no caller above this
    // has to guard a CDP call with try/catch.
    // Encoding and the socket write both throw — unserializable params, a
    // socket already going down — and both used to reject out of a method whose
    // whole contract is that it does not.
    const encoded = Result.try({
      try: () => JSON.stringify(message),
      catch: (cause) =>
        new ProtocolError({
          method,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    })
    if (encoded.isErr()) return Promise.resolve(encoded)

    return new Promise(resolve => {
      this.#pending.set(id, {
        method,
        succeed: value => resolve(Result.ok(value)),
        fail: error => resolve(Result.err(error)),
      })
      const written = Result.try({
        try: () => this.#socket.send(encoded.unwrap()),
        catch: (cause) =>
          new BrowserGoneError({
            message: `${method}: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      })
      if (written.isErr()) {
        this.#pending.delete(id)
        resolve(written)
      }
    })
  }

  #dispatch(raw: string): void {
    // Chrome should never send us anything but JSON, and a socket event handler
    // is no place to throw if it ever does.
    const decoded = Result.try({ try: () => JSON.parse(raw), catch: () => undefined })
    if (decoded.isErr()) return
    const message = decoded.unwrap()
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      if (message.error) {
        pending.fail(
          new ProtocolError({
            method: pending.method,
            message: `${message.error.message} (${message.error.code})`,
          }),
        )
      } else {
        pending.succeed(message.result)
      }
      return
    }
    if (!message.method) return
    const target = message.sessionId ? this.#sessions.get(message.sessionId) : this.browser
    target?._emit(message.method, message.params)
  }

  #abort(error: Error): void {
    if (this.#closed) return
    this.#closed = true
    for (const pending of this.#pending.values()) {
      pending.fail(new BrowserGoneError({ message: `${pending.method}: ${error.message}` }))
    }
    this.#pending.clear()
    this.browser._emit('__disconnected__', error)
  }

  /** Whether the socket has closed, by request or because Chrome exited. */
  get closed(): boolean {
    return this.#closed
  }

  /**
   * Closes the socket.
   *
   * Idempotent. In-flight commands are settled as
   * {@linkcode BrowserGoneError} by the socket's close handler.
   */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    // A socket that refuses to close is one that is already gone.
    Result.try({ try: () => this.#socket.close(), catch: () => undefined })
  }
}
