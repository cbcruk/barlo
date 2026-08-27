/**
 * The barlo application: a Bun-served origin plus one or more Chrome app
 * windows.
 *
 * @module
 */

import { Result } from 'better-result'
import { spawn, type Subprocess } from 'bun'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CDPConnection, type CDPSession, type SendError } from './cdp'
import { findChrome } from './find-chrome'
import { AppServer, BLANK_PATH, type EmbeddedFiles, type RequestHandler } from './server'
import {
  BrowserGoneError,
  ChromeNotFoundError,
  LaunchTimeoutError,
  WindowClosedError,
  type EvaluateError,
  type LaunchError,
  type LoadError,
  type WindowError,
} from './errors'
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

async function readEndpoint(
  profile: string,
  timeout: number,
): Promise<Result<string, LaunchTimeoutError>> {
  const portFile = join(profile, 'DevToolsActivePort')
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      try {
        const [port, path] = readFileSync(portFile, 'utf8').split('\n')
        if (port && path) return Result.ok(`ws://127.0.0.1:${port}${path}`)
      } catch {
        // Windows locks the file while Chrome is writing it, so the read
        // between "it exists" and "it is finished" fails with EBUSY. That is
        // the same not-ready-yet as a missing file, so keep polling.
      }
    }
    await Bun.sleep(50)
  }
  return Result.err(
    new LaunchTimeoutError({
      phase: 'devtools-endpoint',
      ms: timeout,
      message: `Chrome did not publish a DevTools endpoint within ${timeout}ms`,
    }),
  )
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
   * const app = (await launch()).unwrap();
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
   * > The page can take the name back. A classic script's top-level `function`
   * > and `var` declarations become properties of `window`, so a page
   * > containing `function kill` replaces an exposed `kill` and its own calls
   * > reach itself instead of Bun — silently, since the call still returns a
   * > promise. Wrap the page's script so it declares nothing globally, use
   * > `<script type="module">`, or expose under a name the page does not
   * > declare, such as `__kill`. barlo warns after each load, and
   * > {@linkcode Window.shadowedFunctions} reports it for tests.
   *
   * @param name The global to define on the page. Overwrites an existing
   * global of that name, and can in turn be overwritten by one the page
   * declares.
   * @param fn The function to run in Bun. May be async.
   * @returns Nothing once every open window can call it, or the first window
   * that could not be reached.
   *
   * @example Reading a file for the page
   * ```ts
   * import { launch } from "barlo";
   *
   * const app = (await launch()).unwrap();
   *
   * await app.exposeFunction("readFile", (path: string) => Bun.file(path).text());
   * ```
   *
   * The page calls `await window.readFile("notes.md")`.
   */
  async exposeFunction(name: string, fn: ExposedFunction): Promise<Result<void, WindowError>> {
    this.#exposed.set(name, fn)
    // With no windows left there is nothing to install into and none coming, so
    // reporting success here would be a lie the caller acts on.
    if (this.#exited) {
      return Result.err(new BrowserGoneError({ message: `${name}: the app has exited` }))
    }
    const synced = await Promise.all(this.#windows.filter(w => !w.closed).map(w => w.syncBridge()))
    // Every window has to end up with the name, so the first failure is the
    // answer — a bridge installed in only some windows is worse than an error.
    return Result.all(synced).map(() => undefined)
  }

  /**
   * Starts Chrome and opens the first window, cleaning up on failure.
   *
   * @internal
   */
  async _start(): Promise<Result<App, LaunchError>> {
    const started = await Result.tryPromise({
      // #startup reports its own failures; tryPromise is only here for the
      // handshake and the sync filesystem calls, which still reject.
      try: () => this.#startup(),
      catch: (cause): LaunchError =>
        new BrowserGoneError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    })

    const outcome = Result.flatten(started)
    if (outcome.isErr()) this.exit() // never leave a stray Chrome or a socket behind
    return outcome.map(() => this)
  }

  async #startup(): Promise<Result<void, LaunchError | SendError>> {
    const chrome = findChrome(this.#options.executablePath)
    if (chrome.isErr()) return chrome
    this.#executable = chrome.unwrap()

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
    if (endpoint.isErr()) return endpoint

    // CDPConnection.connect is the one step that still rejects: it owns the
    // WebSocket handshake, which has no Result to hand back yet.
    this.#connection = await CDPConnection.connect(endpoint.unwrap())
    this.#browser = this.#connection.browser
    this.#browser.on('__disconnected__', () => this.#onChromeExit())

    const discovering = await this.#browser.send('Target.setDiscoverTargets', { discover: true })
    if (discovering.isErr()) return discovering
    this.#browser.on('Target.targetDestroyed', ({ targetId }) => this.#onTargetDestroyed(targetId))

    const targetId = await this.#waitForPageTarget()
    if (targetId.isErr()) return targetId

    const adopted = await this.#adopt(targetId.unwrap())
    if (adopted.isErr()) return adopted
    this.#windows.push(adopted.unwrap())
    return Result.ok()
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

  async #waitForPageTarget(
    known = new Set<string>(),
  ): Promise<Result<string, LaunchTimeoutError | SendError>> {
    const deadline = Date.now() + (this.#options.timeout ?? DEFAULT_TIMEOUT)
    while (Date.now() < deadline) {
      const targets = await this.#browser!.send<any>('Target.getTargets')
      if (targets.isErr()) return targets
      const page = targets
        .unwrap()
        .targetInfos.find((t: any) => t.type === 'page' && !known.has(t.targetId))
      if (page) return Result.ok(page.targetId as string)
      await Bun.sleep(50)
    }
    return Result.err(
      new LaunchTimeoutError({
        phase: 'window',
        ms: this.#options.timeout ?? DEFAULT_TIMEOUT,
        message: 'Chrome did not open an app window',
      }),
    )
  }

  async #adopt(targetId: string): Promise<Result<Window, SendError>> {
    const attached = await this.#browser!.attach(targetId)
    if (attached.isErr()) return attached
    const session = attached.unwrap()
    const window = new Window(
      session,
      this.#browser!,
      targetId,
      this.#server.origin,
      this.#exposed,
      this.#options.title,
    )
    await window._initialize()
    return Result.ok(window)
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
   *
   * @example Opening a second window
   * ```ts
   * import { launch } from "barlo";
   *
   * const app = (await launch()).unwrap();
   *
   * const preferences = (await app.createWindow("preferences.html")).unwrap();
   *
   * await preferences.setBounds({ width: 480, height: 320 });
   * ```
   */
  async createWindow(uri = ''): Promise<Result<Window, LaunchError | WindowClosedError>> {
    if (!this.#browser) {
      return Result.err(new WindowClosedError({ message: 'the app is not running' }))
    }

    const known = new Set(this.#windows.map(w => w.targetId))
    const url = new URL(uri.replace(/^\//, ''), `${this.#server.origin}/`)
    const { width = 800, height = 600 } = this.#options

    spawn([this.#executable, `--app=${url.href}`, `--user-data-dir=${this.#profile}`,
      `--window-size=${width},${height}`], { stdout: 'ignore', stderr: 'ignore' })

    const targetId = await this.#waitForPageTarget(known)
    if (targetId.isErr()) return targetId

    const adopted = await this.#adopt(targetId.unwrap())
    if (adopted.isOk()) this.#windows.push(adopted.unwrap())
    return adopted
  }

  /**
   * The application's first still-open window.
   *
   * {@linkcode App.load}, {@linkcode App.evaluate}, and
   * {@linkcode App.screenshot} are shorthands for calling the same method on
   * it.
   *
   * @returns The oldest open window, or {@linkcode WindowClosedError} when
   * every window has closed.
   */
  mainWindow(): Result<Window, WindowClosedError> {
    const window = this.#windows.find(w => !w.closed)
    return window
      ? Result.ok(window)
      : Result.err(new WindowClosedError({ message: 'the app has no open windows' }))
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
  async load(uri = '', params?: Record<string, string>): Promise<Result<void, LoadError>> {
    const window = this.mainWindow()
    return window.isErr() ? window : window.unwrap().load(uri, params)
  }

  /**
   * Captures the main window's viewport. See {@linkcode Window.screenshot}.
   *
   * @param options Encoding settings.
   * @returns The encoded image bytes.
   */
  async screenshot(options?: {
    format?: 'png' | 'jpeg' | 'webp'
    quality?: number
  }): Promise<Result<Uint8Array, WindowError>> {
    const window = this.mainWindow()
    return window.isErr() ? window : window.unwrap().screenshot(options)
  }

  /**
   * Runs code in the main window. See {@linkcode Window.evaluate}.
   *
   * @template T The expected result type.
   * @param script A function to call in the page, or an expression to evaluate.
   * @param args Arguments for `script` when it is a function.
   * @returns The value the code produced.
   */
  async evaluate<T = unknown>(
    script: string | ((...args: any[]) => T),
    ...args: unknown[]
  ): Promise<Result<T, EvaluateError>> {
    const window = this.mainWindow()
    return window.isErr() ? window : window.unwrap().evaluate(script, ...args)
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
   * const app = (await launch()).unwrap();
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
   * Shuts the application down when a `using` block ends.
   *
   * Equivalent to {@linkcode App.exit}, so the window, Chrome, the server, and
   * the profile directory are all released without a `try`/`finally`.
   *
   * @example Tying the app to a scope
   * ```ts
   * import { launch } from "barlo";
   *
   * {
   *   await using app = (await launch()).unwrap();
   *
   *   app.serveFolder("./www");
   *   await app.load("index.html");
   *   await app.evaluate("document.title");
   * }
   * // Chrome is gone here, even if the block threw.
   * ```
   */
  async [Symbol.asyncDispose](): Promise<void> {
    this.exit()
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

    // Closing the connection ourselves means no `__disconnected__` arrives to
    // do this, and a window left open here would hand out a session whose
    // Chrome is already gone.
    for (const window of this.#windows) window._markClosed()

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
