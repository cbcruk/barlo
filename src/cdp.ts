/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Carlo leaned on Puppeteer for this; Bun ships a WebSocket client, so the
 * whole transport is a few dozen lines and barlo stays dependency-free.
 */

type Handler = (params: any) => void

interface Pending {
  resolve: (value: any) => void
  reject: (error: Error) => void
}

/** A CDP session: either the browser-level connection or one attached target. */
export class CDPSession {
  readonly sessionId: string | undefined
  #connection: CDPConnection
  #handlers = new Map<string, Set<Handler>>()

  constructor(connection: CDPConnection, sessionId?: string) {
    this.#connection = connection
    this.sessionId = sessionId
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.#connection._send(method, params, this.sessionId)
  }

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

  /** Attach to a target and get a session scoped to it. */
  async attach(targetId: string): Promise<CDPSession> {
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    return this.#connection._register(sessionId)
  }
}

export class CDPConnection {
  #socket: WebSocket
  #nextId = 0
  #pending = new Map<number, Pending>()
  #sessions = new Map<string, CDPSession>()
  #closed = false

  readonly browser: CDPSession

  private constructor(socket: WebSocket) {
    this.#socket = socket
    this.browser = new CDPSession(this)

    socket.onmessage = event => this.#dispatch(String(event.data))
    socket.onclose = () => this.#abort(new Error('CDP connection closed'))
    socket.onerror = () => this.#abort(new Error('CDP connection errored'))
  }

  static async connect(url: string, signal?: AbortSignal): Promise<CDPConnection> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error(`Failed to connect to ${url}`))
      signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
    })
    return new CDPConnection(socket)
  }

  /** @internal */
  _register(sessionId: string): CDPSession {
    let session = this.#sessions.get(sessionId)
    if (!session) this.#sessions.set(sessionId, (session = new CDPSession(this, sessionId)))
    return session
  }

  /** @internal */
  _send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<any> {
    if (this.#closed) return Promise.reject(new Error(`${method}: CDP connection is closed`))
    const id = ++this.#nextId
    const message: Record<string, unknown> = { id, method, params }
    if (sessionId) message.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#socket.send(JSON.stringify(message))
    })
  }

  #dispatch(raw: string): void {
    const message = JSON.parse(raw)
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`))
      else pending.resolve(message.result)
      return
    }
    if (!message.method) return
    const target = message.sessionId ? this.#sessions.get(message.sessionId) : this.browser
    target?._emit(message.method, message.params)
  }

  #abort(error: Error): void {
    if (this.#closed) return
    this.#closed = true
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
    this.browser._emit('__disconnected__', error)
  }

  get closed(): boolean {
    return this.#closed
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#socket.close()
    } catch {}
  }
}
