/**
 * The barlo application: a Bun-served origin plus one or more Chrome app
 * windows.
 *
 * @module
 */

import { spawn, type Subprocess } from 'bun'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CDPConnection, type CDPSession } from './cdp'
import { findChrome } from './find-chrome'
import { AppServer, BLANK_PATH, type EmbeddedFiles, type RequestHandler } from './server'
import { Window, type ExposedFunction } from './window'

/** Settings for {@linkcode launch}. */
export interface LaunchOptions {
  /**
   * Window title, re-applied after every navigation so it wins over the
   * document's own `<title>`. Defaults to letting the document decide.
   */
  title?: string

  /** Initial outer window width in pixels. Defaults to `800`. */
  width?: number

  /** Initial outer window height in pixels. Defaults to `600`. */
  height?: number

  /**
   * Initial distance from the left edge of the screen, in pixels. Applied only
   * when {@linkcode LaunchOptions.top} is given as well; otherwise Chrome
   * places the window.
   */
  left?: number

  /**
   * Initial distance from the top edge of the screen, in pixels. Applied only
   * when {@linkcode LaunchOptions.left} is given as well.
   */
  top?: number

  /**
   * Path to a Chrome, Chromium, Edge, or Brave binary, skipping the search
   * described in {@linkcode findChrome}.
   */
  executablePath?: string

  /**
   * Extra Chrome switches, appended after barlo's own. Chrome resolves
   * duplicate switches last-wins, so these override the defaults.
   *
   * Note that `--headless` cannot be undone this way: Chrome decides from the
   * switch's presence, not its value.
   */
  args?: string[]

  /**
   * Profile directory, holding cookies, localStorage, and the DevTools
   * endpoint file.
   *
   * A temporary directory is created and deleted on exit when omitted. Pass a
   * stable path to persist state between runs.
   */
  userDataDir?: string

  /**
   * Forward Chrome's stderr to Bun's. Defaults to `false`.
   *
   * Chrome is noisy even when healthy, but this is where a startup crash
   * reports itself.
   */
  verbose?: boolean

  /**
   * Milliseconds to wait for Chrome to start and open its window. Defaults to
   * `20000`.
   */
  timeout?: number
}

const DEFAULT_TIMEOUT = 20_000

async function readEndpoint(profile: string, timeout: number): Promise<string> {
  const portFile = join(profile, 'DevToolsActivePort')
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, 'utf8').split('\n')
      if (port && path) return `ws://127.0.0.1:${port}${path}`
    }
    await Bun.sleep(50)
  }
  throw new Error(`Chrome did not publish a DevTools endpoint within ${timeout}ms`)
}

/**
 * A running barlo application: an HTTP origin, a Chrome process, and its
 * windows.
 *
 * Created by {@linkcode launch}, which is the only supported way to get one —
 * the constructor does not start anything.
 *
 * Serving routes and exposed functions are registered on the app and shared by
 * every window it opens.
 */
export class App {
  #server = new AppServer()
  #chrome: Subprocess | undefined
  #connection: CDPConnection | undefined
  #browser: CDPSession | undefined
  #windows: Window[] = []
  #exposed = new Map<string, ExposedFunction>()
  #exitHandlers = new Set<() => void>()
  #options: LaunchOptions
  #profile = ''
  #ownsProfile = false
  #executable = ''
  #exited = false

  /**
   * Stores the launch settings. Nothing is started until `_start` runs.
   *
   * @internal
   */
  constructor(options: LaunchOptions) {
    this.#options = options
  }

  // -- serving -------------------------------------------------------------

  /**
   * Serves files from a folder on disk. See {@linkcode AppServer.serveFolder}.
   *
   * > Does not survive `bun build --compile`; use
   * > {@linkcode App.serveEmbedded} for compiled applications.
   *
   * @param folder Path to the folder, resolved against the working directory.
   * @param prefix URL prefix to mount it under.
   */
  serveFolder(folder: string, prefix = '/'): void {
    this.#server.serveFolder(folder, prefix)
  }

  /**
   * Reverse-proxies a prefix onto a remote origin, such as a dev server. See
   * {@linkcode AppServer.serveOrigin}.
   *
   * @param base The origin to proxy to.
   * @param prefix URL prefix to mount it under.
   */
  serveOrigin(base: string, prefix = '/'): void {
    this.#server.serveOrigin(base, prefix)
  }

  /**
   * Serves an in-memory map of path to contents. See
   * {@linkcode AppServer.serveEmbedded}.
   *
   * Unlike {@linkcode App.serveFolder}, the contents live in the bundle rather
   * than on disk, so this is the serving method that survives
   * `bun build --compile`.
   *
   * @param files The paths to serve and their contents.
   * @param prefix URL prefix to mount them under.
   *
   * @example Embedding a page into a compiled binary
   * ```ts
   * import { launch } from "barlo";
   * import index from "./www/index.html" with { type: "text" };
   *
   * const app = await launch();
   *
   * app.serveEmbedded({ "index.html": index as unknown as string });
   * await app.load("index.html");
   * ```
   */
  serveEmbedded(files: EmbeddedFiles, prefix = '/'): void {
    this.#server.serveEmbedded(files, prefix)
  }

  /**
   * Registers a fallthrough request handler. See
   * {@linkcode AppServer.serveHandler}.
   *
   * @param handler Called with the request; return `undefined` to decline.
   */
  serveHandler(handler: RequestHandler): void {
    this.#server.serveHandler(handler)
  }

  // -- bridge --------------------------------------------------------------

  /**
   * Makes a Bun-side function callable from the page as `window[name]`.
   *
   * The page-side function always returns a promise, whatever `fn` returns.
   * Arguments and results round-trip as JSON, and a thrown error rejects the
   * page's promise with the same message.
   *
   * Takes effect immediately in every open window, including their current
   * documents, so there is no need to reload or to expose everything before
   * the first {@linkcode App.load}. Windows opened later inherit it. Exposing
   * the same name twice replaces the earlier function.
   *
   * @param name The global to define on the page. Overwrites an existing
   * global of that name.
   * @param fn The function to run in Bun. May be async.
   *
   * @example Reading a file for the page
   * ```ts
   * import { launch } from "barlo";
   *
   * const app = await launch();
   *
   * await app.exposeFunction("readFile", (path: string) => Bun.file(path).text());
   * ```
   *
   * The page calls `await window.readFile("notes.md")`.
   */
  async exposeFunction(name: string, fn: ExposedFunction): Promise<void> {
    this.#exposed.set(name, fn)
    await Promise.all(this.#windows.filter(w => !w.closed).map(w => w.syncBridge()))
  }

  // -- lifecycle -----------------------------------------------------------

  /**
   * Starts Chrome and opens the first window, cleaning up on failure.
   *
   * @internal
   */
  async _start(): Promise<void> {
    try {
      await this.#startup()
    } catch (error) {
      // Never leave a stray Chrome or a listening socket behind.
      this.exit()
      throw error instanceof Error
        ? new Error(`barlo failed to launch: ${error.message}`, { cause: error })
        : error
    }
  }

  async #startup(): Promise<void> {
    this.#executable = findChrome(this.#options.executablePath)

    if (this.#options.userDataDir) {
      this.#profile = this.#options.userDataDir
    } else {
      this.#profile = mkdtempSync(join(tmpdir(), 'barlo-'))
      this.#ownsProfile = true
    }

    const origin = this.#server.listen()

    this.#chrome = spawn([this.#executable, ...this.#chromeArgs(origin)], {
      stdout: 'ignore',
      stderr: this.#options.verbose ? 'inherit' : 'ignore',
      onExit: () => this.#onChromeExit(),
    })

    const endpoint = await readEndpoint(this.#profile, this.#options.timeout ?? DEFAULT_TIMEOUT)
    this.#connection = await CDPConnection.connect(endpoint)
    this.#browser = this.#connection.browser
    this.#browser.on('__disconnected__', () => this.#onChromeExit())

    await this.#browser.send('Target.setDiscoverTargets', { discover: true })
    this.#browser.on('Target.targetDestroyed', ({ targetId }) => this.#onTargetDestroyed(targetId))

    const targetId = await this.#waitForPageTarget()
    this.#windows.push(await this.#adopt(targetId))
  }

  #chromeArgs(origin: string): string[] {
    const { width = 800, height = 600, left, top, args = [] } = this.#options
    const flags = [
      `--app=${origin}${BLANK_PATH}`,
      '--remote-debugging-port=0',
      `--user-data-dir=${this.#profile}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--disable-background-networking',
      '--disable-component-update',
    ]
    if (left !== undefined && top !== undefined) flags.push(`--window-position=${left},${top}`)
    return [...flags, ...args]
  }

  async #waitForPageTarget(known = new Set<string>()): Promise<string> {
    const deadline = Date.now() + (this.#options.timeout ?? DEFAULT_TIMEOUT)
    while (Date.now() < deadline) {
      const { targetInfos } = await this.#browser!.send<any>('Target.getTargets')
      const page = targetInfos.find((t: any) => t.type === 'page' && !known.has(t.targetId))
      if (page) return page.targetId
      await Bun.sleep(50)
    }
    throw new Error('Chrome did not open an app window')
  }

  async #adopt(targetId: string): Promise<Window> {
    const session = await this.#browser!.attach(targetId)
    const window = new Window(
      session,
      this.#browser!,
      targetId,
      this.#server.origin,
      this.#exposed,
      this.#options.title,
    )
    await window._initialize()
    return window
  }

  /**
   * Opens another app window on the same origin.
   *
   * Re-running the Chrome binary against the same profile hands the request to
   * the running browser process, which is how Carlo did it too — CDP has no
   * app-mode window type. The new window inherits every exposed function.
   *
   * @param uri A path relative to the origin for the new window to open.
   * Defaults to the origin root.
   * @returns The new window, already navigated and bridged.
   * @throws When the app is not running, or when no new window appears within
   * {@linkcode LaunchOptions.timeout} milliseconds.
   *
   * @example Opening a second window
   * ```ts
   * import { launch } from "barlo";
 *
 * const app = await launch();
 *
   * const preferences = await app.createWindow("preferences.html");
   *
   * await preferences.setBounds({ width: 480, height: 320 });
   * ```
   */
  async createWindow(uri = ''): Promise<Window> {
    if (!this.#browser) throw new Error('App is not running')

    const known = new Set(this.#windows.map(w => w.targetId))
    const url = new URL(uri.replace(/^\//, ''), `${this.#server.origin}/`)
    const { width = 800, height = 600 } = this.#options

    spawn([this.#executable, `--app=${url.href}`, `--user-data-dir=${this.#profile}`,
      `--window-size=${width},${height}`], { stdout: 'ignore', stderr: 'ignore' })

    const targetId = await this.#waitForPageTarget(known)
    const window = await this.#adopt(targetId)
    this.#windows.push(window)
    return window
  }

  /**
   * The application's first still-open window.
   *
   * {@linkcode App.load}, {@linkcode App.evaluate}, and
   * {@linkcode App.screenshot} are shorthands for calling the same method on
   * it.
   *
   * @returns The oldest open window.
   * @throws When every window has closed.
   */
  mainWindow(): Window {
    const window = this.#windows.find(w => !w.closed)
    if (!window) throw new Error('App has no open windows')
    return window
  }

  /**
   * Every open window, oldest first.
   *
   * @returns A new array; closed windows are omitted.
   */
  windows(): Window[] {
    return this.#windows.filter(w => !w.closed)
  }

  /**
   * Navigates the main window. See {@linkcode Window.load}.
   *
   * @param uri A path relative to the origin. Defaults to the origin root.
   * @param params Query parameters to append.
   */
  load(uri = '', params?: Record<string, string>): Promise<void> {
    return this.mainWindow().load(uri, params)
  }

  /**
   * Captures the main window's viewport. See {@linkcode Window.screenshot}.
   *
   * @param options Encoding settings.
   * @returns The encoded image bytes.
   */
  screenshot(options?: { format?: 'png' | 'jpeg' | 'webp'; quality?: number }): Promise<Uint8Array> {
    return this.mainWindow().screenshot(options)
  }

  /**
   * Runs code in the main window. See {@linkcode Window.evaluate}.
   *
   * @template T The expected result type.
   * @param script A function to call in the page, or an expression to evaluate.
   * @param args Arguments for `script` when it is a function.
   * @returns The value the code produced.
   */
  evaluate<T = unknown>(script: string | ((...args: any[]) => T), ...args: unknown[]): Promise<T> {
    return this.mainWindow().evaluate(script, ...args)
  }

  #onTargetDestroyed(targetId: string): void {
    const window = this.#windows.find(w => w.targetId === targetId)
    if (!window) return
    window._markClosed()
    if (this.windows().length === 0) this.exit()
  }

  #onChromeExit(): void {
    for (const window of this.#windows) window._markClosed()
    this.exit()
  }

  /**
   * Registers a handler for the application exiting.
   *
   * Fires when the last window closes, when Chrome quits, and when
   * {@linkcode App.exit} is called. barlo does not stop the Bun process
   * itself, so this is where an application usually calls `process.exit`.
   *
   * @param handler Called once, when the application exits.
   * @returns A function that removes the handler.
   *
   * @example Quitting with the window
   * ```ts
   * import { launch } from "barlo";
 *
 * const app = await launch();
 *
   * app.onExit(() => process.exit(0));
   * ```
   */
  onExit(handler: () => void): () => void {
    this.#exitHandlers.add(handler)
    return () => this.#exitHandlers.delete(handler)
  }

  /** Whether the application has exited. */
  get exited(): boolean {
    return this.#exited
  }

  /**
   * Shuts the application down.
   *
   * Closes the CDP connection, stops the HTTP server, kills Chrome, and
   * removes the profile directory if barlo created it. Idempotent, and safe to
   * call from an {@linkcode App.onExit} handler.
   */
  exit(): void {
    if (this.#exited) return
    this.#exited = true

    this.#connection?.close()
    this.#server.stop()
    try {
      this.#chrome?.kill()
    } catch {}
    if (this.#ownsProfile) {
      try {
        rmSync(this.#profile, { recursive: true, force: true })
      } catch {}
    }
    for (const handler of this.#exitHandlers) handler()
  }
}
