/** A Chrome app-mode window, driven over its own CDP session. */

import type { CDPSession } from './cdp'
import { BINDING, bootstrapSource, resolverExpression, type RpcCall } from './rpc'

export interface Bounds {
  left?: number
  top?: number
  width?: number
  height?: number
}

type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen'

export type ExposedFunction = (...args: any[]) => unknown

export class Window {
  readonly targetId: string
  readonly session: CDPSession

  /** Browser-domain commands (Browser.*, Target.*) are not session-scoped. */
  #browser: CDPSession
  #origin: string
  #exposed: Map<string, ExposedFunction>
  #title: string | undefined
  #bootstrapId: string | undefined
  #closeHandlers = new Set<() => void>()
  #closed = false

  /** @internal */
  constructor(
    session: CDPSession,
    browser: CDPSession,
    targetId: string,
    origin: string,
    exposed: Map<string, ExposedFunction>,
    title?: string,
  ) {
    this.session = session
    this.#browser = browser
    this.targetId = targetId
    this.#origin = origin
    this.#exposed = exposed
    this.#title = title
  }

  /** @internal — enable the domains and install the RPC bridge. */
  async _initialize(): Promise<void> {
    await this.session.send('Page.enable')
    await this.session.send('Runtime.enable')
    await this.session.send('Runtime.addBinding', { name: BINDING })
    this.session.on('Runtime.bindingCalled', params => {
      if (params.name === BINDING) void this.#onBindingCalled(params.payload)
    })
    await this.syncBridge()
    this.session.on('Page.loadEventFired', () => void this.#applyTitle())
  }

  /** Re-inject the bootstrap so newly exposed names reach future documents. */
  async syncBridge(): Promise<void> {
    if (this.#closed) return
    if (this.#bootstrapId) {
      await this.session
        .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.#bootstrapId })
        .catch(() => {})
    }
    const source = bootstrapSource(this.#exposed.keys())
    const { identifier } = await this.session.send<{ identifier: string }>(
      'Page.addScriptToEvaluateOnNewDocument',
      { source },
    )
    this.#bootstrapId = identifier

    // The document script only reaches *future* documents. Adopting a window
    // that already navigated, or exposing a function after load, needs the
    // bootstrap run against the current document too.
    await this.session.send('Runtime.evaluate', { expression: source }).catch(() => {})
  }

  async #onBindingCalled(payload: string): Promise<void> {
    let call: RpcCall
    try {
      call = JSON.parse(payload)
    } catch {
      return
    }

    const fn = this.#exposed.get(call.name)
    let ok = true
    let value: unknown
    try {
      if (!fn) throw new Error(`${call.name} is not exposed`)
      value = await fn(...call.args)
    } catch (error) {
      ok = false
      value = error
    }

    await this.session
      .send('Runtime.evaluate', { expression: resolverExpression(call.id, ok, value) })
      .catch(() => {})
  }

  /** Navigate to a path relative to the app origin (Carlo's app.load). */
  async load(uri = '', params?: Record<string, string>): Promise<void> {
    const url = new URL(uri.replace(/^\//, ''), `${this.#origin}/`)
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value)

    const loaded = new Promise<void>(resolve => {
      const off = this.session.on('Page.loadEventFired', () => {
        off()
        resolve()
      })
    })
    await this.session.send('Page.navigate', { url: url.href })
    await loaded
    await this.#applyTitle()
  }

  async #applyTitle(): Promise<void> {
    if (!this.#title) return
    await this.session
      .send('Runtime.evaluate', { expression: `document.title = ${JSON.stringify(this.#title)}` })
      .catch(() => {})
  }

  /**
   * Evaluate in the page. Accepts a function (serialized and called with the
   * given arguments) or an expression string.
   */
  async evaluate<T = unknown>(script: string | ((...args: any[]) => T), ...args: unknown[]): Promise<T> {
    const expression =
      typeof script === 'function'
        ? `(${script.toString()})(${args.map(arg => JSON.stringify(arg ?? null)).join(', ')})`
        : script

    const result = await this.session.send<any>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const details = result.exceptionDetails
      throw new Error(details.exception?.description ?? details.text ?? 'Evaluation failed')
    }
    return result.result.value as T
  }

  /** Capture the window's viewport as an image. */
  async screenshot(options: { format?: 'png' | 'jpeg' | 'webp'; quality?: number } = {}): Promise<Uint8Array> {
    const { data } = await this.session.send<{ data: string }>('Page.captureScreenshot', {
      format: options.format ?? 'png',
      ...(options.quality !== undefined ? { quality: options.quality } : {}),
    })
    return Uint8Array.from(atob(data), c => c.charCodeAt(0))
  }

  async bounds(): Promise<Required<Bounds> & { windowState: WindowState }> {
    const { bounds } = await this.#browser.send<any>('Browser.getWindowForTarget', {
      targetId: this.targetId,
    })
    return bounds
  }

  async setBounds(bounds: Bounds): Promise<void> {
    const { windowId } = await this.#browser.send<any>('Browser.getWindowForTarget', {
      targetId: this.targetId,
    })
    await this.#browser.send('Browser.setWindowBounds', { windowId, bounds })
  }

  async #setState(windowState: WindowState): Promise<void> {
    const { windowId } = await this.#browser.send<any>('Browser.getWindowForTarget', {
      targetId: this.targetId,
    })
    // Chrome rejects a state change made directly from another non-normal state.
    await this.#browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    if (windowState !== 'normal')
      await this.#browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState } })
  }

  fullscreen = () => this.#setState('fullscreen')
  maximize = () => this.#setState('maximized')
  minimize = () => this.#setState('minimized')

  bringToFront(): Promise<void> {
    return this.session.send('Page.bringToFront')
  }

  onClose(handler: () => void): () => void {
    this.#closeHandlers.add(handler)
    return () => this.#closeHandlers.delete(handler)
  }

  get closed(): boolean {
    return this.#closed
  }

  /** @internal */
  _markClosed(): void {
    if (this.#closed) return
    this.#closed = true
    for (const handler of this.#closeHandlers) handler()
  }

  async close(): Promise<void> {
    if (this.#closed) return
    await this.#browser.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {})
    this._markClosed()
  }
}
