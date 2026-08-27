/**
 * A Chrome app-mode window and the operations available on it.
 *
 * @module
 */

import type { CDPSession } from './cdp'
import { BINDING, bootstrapSource, resolverExpression, shadowedExpression, type RpcCall } from './rpc'

/**
 * A window's position and size in screen pixels.
 *
 * Every field is optional: {@linkcode Window.setBounds} changes only the ones
 * given, leaving the rest as they are.
 */
export interface Bounds {
  /** Distance from the left edge of the screen. */
  left?: number
  /** Distance from the top edge of the screen. */
  top?: number
  /** Outer width, including the window frame. */
  width?: number
  /** Outer height, including the window frame. */
  height?: number
}

type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen'

/**
 * A Bun-side function callable from the page.
 *
 * Arguments arrive from the page as JSON, and the return value travels back
 * the same way, so it must be JSON-serializable. Returning a promise is
 * supported — the page waits for it. A thrown error rejects the page's promise
 * with an `Error` carrying the same message.
 */
export type ExposedFunction = (...args: any[]) => unknown

/**
 * One Chrome app-mode window, driven over its own CDP session.
 *
 * Obtained from {@linkcode App.mainWindow}, {@linkcode App.windows}, or
 * {@linkcode App.createWindow} — never constructed directly, since a window
 * has to be adopted by an {@linkcode App} to receive the RPC bridge.
 */
export class Window {
  /** The window's CDP target identifier, unique within the browser. */
  readonly targetId: string

  /**
   * The CDP session scoped to this window's page.
   *
   * Exposed as an escape hatch for protocol calls barlo does not wrap, such as
   * `Emulation.setUserAgentOverride`.
   */
  readonly session: CDPSession

  /** Browser-domain commands (Browser.*, Target.*) are not session-scoped. */
  #browser: CDPSession
  #origin: string
  #exposed: Map<string, ExposedFunction>
  #title: string | undefined
  #bootstrapId: string | undefined
  #closeHandlers = new Set<() => void>()
  #closed = false

  /**
   * Creates a window wrapper around an attached CDP session.
   *
   * @internal
   */
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

  /**
   * Enables the CDP domains and installs the RPC bridge.
   *
   * @internal
   */
  async _initialize(): Promise<void> {
    await this.session.send('Page.enable')
    await this.session.send('Runtime.enable')
    await this.session.send('Runtime.addBinding', { name: BINDING })
    this.session.on('Runtime.bindingCalled', params => {
      if (params.name === BINDING) void this.#onBindingCalled(params.payload)
    })
    await this.syncBridge()
    this.session.on('Page.loadEventFired', () => {
      void this.#applyTitle()
      void this.#warnAboutShadowing()
    })
  }

  /**
   * Re-installs the RPC bridge so newly exposed names are callable.
   *
   * Applies to the current document as well as future ones, which is what lets
   * {@linkcode App.exposeFunction} take effect without a reload. Called by
   * {@linkcode App}; there is no need to call it directly.
   *
   * Does nothing once the window is closed.
   */
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

  /**
   * Navigates to a path relative to the application's origin.
   *
   * Resolves once the page's `load` event has fired, so the document is ready
   * for {@linkcode Window.evaluate} on return.
   *
   * @param uri A path such as `"index.html"`, relative to the origin. A
   * leading slash is tolerated. Defaults to the origin root.
   * @param params Query parameters to append.
   *
   * @example Passing state into the page
   * ```ts
   * import { launch } from "barlo";
   *
   * const app = await launch();
   *
   * app.serveFolder("./www");
   * await app.mainWindow().load("editor.html", { file: "notes.md" });
   * ```
   */
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

  /**
   * Lists exposed functions the loaded page has replaced with its own globals.
   *
   * A classic script's top-level `function` and `var` declarations become
   * properties of `window`, which is where {@linkcode App.exposeFunction}
   * installs its functions. A page declaring `function kill` therefore takes
   * over an exposed `kill`, and calls from the page reach the page itself
   * instead of Bun — silently, since the call still returns a promise.
   *
   * Wrap the page's script so it declares nothing globally, use
   * `<script type="module">`, or expose the function under a name the page does
   * not declare. barlo warns about this automatically after each load; this
   * method is for asserting on it in tests.
   *
   * @returns The shadowed names, empty when the bridge is intact.
   *
   * @example Guarding the bridge in a test
   * ```ts
   * import { launch } from "barlo";
   *
   * const app = await launch();
   *
   * await app.load("index.html");
   * console.assert((await app.mainWindow().shadowedFunctions()).length === 0);
   * ```
   */
  async shadowedFunctions(): Promise<string[]> {
    if (this.#closed) return []
    return this.evaluate<string[]>(shadowedExpression()).catch(() => [])
  }

  async #warnAboutShadowing(): Promise<void> {
    const shadowed = await this.shadowedFunctions()
    if (shadowed.length === 0) return
    console.warn(
      `barlo: the page replaced ${shadowed.map(n => `window.${n}`).join(', ')}, so calls ` +
        `reach the page instead of the exposed function. A classic script's top-level ` +
        `\`function\` and \`var\` declarations become window properties — wrap the page ` +
        `script, use <script type="module">, or expose under a different name.`,
    )
  }

  async #applyTitle(): Promise<void> {
    if (!this.#title) return
    await this.session
      .send('Runtime.evaluate', { expression: `document.title = ${JSON.stringify(this.#title)}` })
      .catch(() => {})
  }

  /**
   * Runs code in the page and returns its result.
   *
   * A function is serialized and called with the given arguments, which means
   * it runs in the page and cannot close over anything in Bun. A string is
   * evaluated as an expression. Promises are awaited before the value is
   * returned.
   *
   * The result travels as JSON, so DOM nodes and functions do not survive the
   * trip.
   *
   * @template T The expected result type. Not checked at runtime.
   * @param script A function to call in the page, or an expression to evaluate.
   * @param args Arguments for `script` when it is a function. Serialized to
   * JSON, so they must not contain functions or cycles.
   * @returns The value the code produced.
   * @throws When the code throws in the page, carrying the page-side message.
   *
   * @example Reading from the DOM
   * ```ts
   * import { launch } from "barlo";
 *
 * const app = await launch();
 *
   * const title = await app.evaluate<string>("document.title");
   * ```
   *
   * @example Calling a function with arguments
   * ```ts
   * import { launch } from "barlo";
 *
 * const app = await launch();
 *
   * const sum = await app.evaluate((a: number, b: number) => a + b, 2, 3);
   * ```
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

  /**
   * Captures the window's viewport as an image.
   *
   * @param options Encoding settings.
   * @param options.format Image format. Defaults to `"png"`.
   * @param options.quality Compression quality from 0 to 100. Ignored for
   * `"png"`.
   * @returns The encoded image bytes.
   *
   * @example Saving a screenshot
   * ```ts
   * import { launch } from "barlo";
 *
 * const app = await launch();
 *
   * await Bun.write("shot.png", await app.screenshot());
   * ```
   */
  async screenshot(options: { format?: 'png' | 'jpeg' | 'webp'; quality?: number } = {}): Promise<Uint8Array> {
    const { data } = await this.session.send<{ data: string }>('Page.captureScreenshot', {
      format: options.format ?? 'png',
      ...(options.quality !== undefined ? { quality: options.quality } : {}),
    })
    return Uint8Array.from(atob(data), c => c.charCodeAt(0))
  }

  /**
   * Reads the window's current position, size, and state.
   *
   * @returns The bounds, with every field populated, plus the window state.
   */
  async bounds(): Promise<Required<Bounds> & { windowState: WindowState }> {
    const { bounds } = await this.#browser.send<any>('Browser.getWindowForTarget', {
      targetId: this.targetId,
    })
    return bounds
  }

  /**
   * Moves or resizes the window.
   *
   * Omitted fields are left unchanged. Has no visible effect while the window
   * is maximized or fullscreen.
   *
   * Height does not round-trip on macOS: a window set to 700 comes back as 677,
   * short by the title bar, from both {@linkcode Window.bounds} and the page's
   * `window.outerHeight`. Add the title bar yourself if an exact height
   * matters there. Width is exact everywhere, as is height on Linux and
   * Windows.
   *
   * @param bounds The position and size fields to change.
   *
   * @example Centring a window
   * ```ts
   * import { launch } from "barlo";
 *
 * const app = await launch();
 *
   * await app.mainWindow().setBounds({ left: 200, top: 120, width: 900, height: 700 });
   * ```
   */
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

  /** Puts the window into fullscreen. */
  fullscreen = () => this.#setState('fullscreen')

  /** Maximizes the window. */
  maximize = () => this.#setState('maximized')

  /** Minimizes the window. */
  minimize = () => this.#setState('minimized')

  /** Raises the window above other windows and focuses it. */
  bringToFront(): Promise<void> {
    return this.session.send('Page.bringToFront')
  }

  /**
   * Registers a handler for the window closing.
   *
   * Fires whether the user closed the window, {@linkcode Window.close} did, or
   * Chrome exited.
   *
   * @param handler Called once, when the window closes.
   * @returns A function that removes the handler.
   */
  onClose(handler: () => void): () => void {
    this.#closeHandlers.add(handler)
    return () => this.#closeHandlers.delete(handler)
  }

  /** Whether the window has closed. Operations on a closed window fail. */
  get closed(): boolean {
    return this.#closed
  }

  /**
   * Marks the window closed and runs its close handlers.
   *
   * @internal
   */
  _markClosed(): void {
    if (this.#closed) return
    this.#closed = true
    for (const handler of this.#closeHandlers) handler()
  }

  /**
   * Closes the window when a `using` block ends.
   *
   * Equivalent to {@linkcode Window.close}. Closing the application's last
   * window exits it, so a scoped window is a scoped application when it is the
   * only one.
   *
   * @example A secondary window that cannot outlive its block
   * ```ts
   * import { launch } from "barlo";
   *
   * const app = await launch();
   *
   * {
   *   await using preferences = await app.createWindow("preferences.html");
   *
   *   await preferences.evaluate("document.title");
   * }
   * ```
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  /**
   * Closes the window.
   *
   * Idempotent. Closing the last window of an {@linkcode App} exits the
   * application.
   */
  async close(): Promise<void> {
    if (this.#closed) return
    await this.#browser.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {})
    this._markClosed()
  }
}
