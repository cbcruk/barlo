/** The barlo application: a Bun-served origin plus one or more Chrome app windows. */

import { spawn, type Subprocess } from 'bun'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CDPConnection, type CDPSession } from './cdp'
import { findChrome } from './find-chrome'
import { AppServer, BLANK_PATH, type EmbeddedFiles, type RequestHandler } from './server'
import { Window, type ExposedFunction } from './window'

export interface LaunchOptions {
  /** Window title. Defaults to the document title. */
  title?: string
  width?: number
  height?: number
  left?: number
  top?: number
  /** Path to a Chrome/Chromium binary. Overrides auto-detection. */
  executablePath?: string
  /** Extra Chrome switches, appended last (Chrome resolves duplicates last-wins). */
  args?: string[]
  /**
   * Profile directory. A temporary one is created and deleted on exit when
   * omitted; pass a stable path to persist cookies and localStorage.
   */
  userDataDir?: string
  /** Send Chrome's stderr to Bun's. Useful when Chrome dies silently. */
  verbose?: boolean
  /** Milliseconds to wait for Chrome to publish its DevTools endpoint. */
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

  /** @internal */
  constructor(options: LaunchOptions) {
    this.#options = options
  }

  // -- serving -------------------------------------------------------------

  serveFolder(folder: string, prefix = '/'): void {
    this.#server.serveFolder(folder, prefix)
  }

  serveOrigin(base: string, prefix = '/'): void {
    this.#server.serveOrigin(base, prefix)
  }

  /**
   * Serve an in-memory map of path -> contents. Unlike serveFolder, this
   * survives `bun build --compile`, where there is no folder on disk:
   *
   *     import index from './www/index.html' with { type: 'text' }
   *     app.serveEmbedded({ 'index.html': index })
   */
  serveEmbedded(files: EmbeddedFiles, prefix = '/'): void {
    this.#server.serveEmbedded(files, prefix)
  }

  serveHandler(handler: RequestHandler): void {
    this.#server.serveHandler(handler)
  }

  // -- bridge --------------------------------------------------------------

  /** Make a Bun-side function callable from the page as `window[name]`. */
  async exposeFunction(name: string, fn: ExposedFunction): Promise<void> {
    this.#exposed.set(name, fn)
    await Promise.all(this.#windows.filter(w => !w.closed).map(w => w.syncBridge()))
  }

  // -- lifecycle -----------------------------------------------------------

  /** @internal */
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
   * Open another app window. Re-running the Chrome binary against the same
   * profile hands the request to the running browser process, which is how
   * Carlo did it too — CDP has no app-mode window type.
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

  mainWindow(): Window {
    const window = this.#windows.find(w => !w.closed)
    if (!window) throw new Error('App has no open windows')
    return window
  }

  windows(): Window[] {
    return this.#windows.filter(w => !w.closed)
  }

  load(uri = '', params?: Record<string, string>): Promise<void> {
    return this.mainWindow().load(uri, params)
  }

  screenshot(options?: { format?: 'png' | 'jpeg' | 'webp'; quality?: number }): Promise<Uint8Array> {
    return this.mainWindow().screenshot(options)
  }

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

  /** Fires when the last window closes or Chrome quits. */
  onExit(handler: () => void): () => void {
    this.#exitHandlers.add(handler)
    return () => this.#exitHandlers.delete(handler)
  }

  get exited(): boolean {
    return this.#exited
  }

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
