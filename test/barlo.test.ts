import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Result } from 'better-result'

import { ChromeNotFoundError, ProtocolError, launch, type App, type Window } from '../src/index'

/**
 * Unwraps a Result in a test, failing with the tagged error rather than a
 * `Panic` that hides which failure it was.
 */
function must<T, E>(result: Result<T, E>): T {
  if (result.isErr()) {
    const e = result.error as { _tag?: string; message?: string }
    throw new Error(`expected Ok, got ${e?._tag ?? 'Err'}: ${e?.message ?? String(e)}`)
  }
  return result.unwrap()
}

const www = mkdtempSync(join(tmpdir(), 'barlo-test-www-'))
writeFileSync(join(www, 'index.html'), '<!doctype html><title>Fixture</title><h1 id="t">hello</h1>')
writeFileSync(join(www, 'nested.html'), '<!doctype html><p id="n">nested</p>')
// A classic script's top-level declarations land on `window`, over the bridge.
writeFileSync(
  join(www, 'shadow.html'),
  `<!doctype html><script>async function add(a, b) { return 'page' }</script>`,
)
writeFileSync(
  join(www, 'wrapped.html'),
  `<!doctype html><script>;(() => { async function add() { return 'page' } })()</script>`,
)
writeFileSync(
  join(www, 'module.html'),
  `<!doctype html><script type="module">async function add() { return 'page' }</script>`,
)

/**
 * Frame allowance for an app-mode window, in pixels.
 *
 * The frame is platform-specific — measured at 0-11 on Linux, 32 on macOS, and
 * 39 on Windows — so this cannot assert zero. A tabbed window spends about 87
 * pixels more on the toolbar, so anything under this means the toolbar is gone,
 * which is the property under test.
 */
const MAX_APP_CHROME = 60

let app: App

beforeAll(async () => {
  app = must(await launch({ width: 640, height: 480, title: 'Barlo Test' }))
  app.serveFolder(www)
  app.serveHandler(request =>
    new URL(request.url).pathname === '/api/ping' ? new Response('pong') : undefined,
  )
  app.serveEmbedded({ 'hi.txt': 'embedded!' }, '/embedded')
  await app.exposeFunction('add', (a: number, b: number) => a + b)
  await app.exposeFunction('boom', () => {
    throw new Error('kaboom')
  })
  await app.load('index.html')
}, 60_000)

afterAll(() => app?.exit())

describe('window', () => {
  test('opens a real, non-headless window', async () => {
    expect(must(await app.evaluate<string>('navigator.userAgent'))).not.toContain('Headless')
  })

  test('runs in app mode with no browser chrome', async () => {
    expect(must(await app.evaluate<number>('outerHeight - innerHeight'))).toBeLessThan(MAX_APP_CHROME)
  })

  test('honours the requested size', async () => {
    expect(must(await app.evaluate<string>('[outerWidth, outerHeight].join("x")'))).toBe('640x480')
  })

  test('applies the configured title over the document title', async () => {
    expect(must(await app.evaluate<string>('document.title'))).toBe('Barlo Test')
  })

  test('resizes via bounds', async () => {
    await must(app.mainWindow()).setBounds({ width: 900, height: 700 })
    await Bun.sleep(300)

    const bounds = must(await must(app.mainWindow()).bounds())
    expect(bounds.width).toBe(900)
    expect(must(await app.evaluate<number>('outerWidth'))).toBe(900)

    // Height does not round-trip on macOS: asking for 700 yields 677, short by
    // the title bar, and both `bounds()` and `outerHeight` agree on 677. Every
    // other platform is exact, so the allowance is one title bar, not a range.
    expect(700 - bounds.height).toBeGreaterThanOrEqual(0)
    expect(700 - bounds.height).toBeLessThanOrEqual(30)
    expect(must(await app.evaluate<number>('outerHeight'))).toBe(bounds.height)
  })
})

describe('serving', () => {
  test('serves the folder', async () => {
    expect(must(await app.evaluate<string>('document.getElementById("t").textContent'))).toBe('hello')
  })

  test('navigates to another served file', async () => {
    await app.load('nested.html')
    expect(must(await app.evaluate<string>('document.getElementById("n").textContent'))).toBe('nested')
    await app.load('index.html')
  })

  test('serves an embedded file map', async () => {
    expect(must(await app.evaluate<string>('fetch("/embedded/hi.txt").then(r => r.text())'))).toBe('embedded!')
  })

  test('falls through to a custom handler', async () => {
    expect(must(await app.evaluate<string>('fetch("/api/ping").then(r => r.text())'))).toBe('pong')
  })

  test('refuses paths escaping the served folder', async () => {
    expect(must(await app.evaluate<number>('fetch("/../../etc/passwd").then(r => r.status)'))).toBe(404)
  })
})

describe('exposeFunction', () => {
  test('round-trips arguments and return values', async () => {
    expect(must(await app.evaluate<number>('add(2, 3)'))).toBe(5)
  })

  test('survives a reload', async () => {
    await app.load('index.html')
    expect(must(await app.evaluate<number>('add(10, 20)'))).toBe(30)
  })

  test('propagates errors to the page', async () => {
    expect(must(await app.evaluate<string>('boom().then(() => "no throw", e => e.message)'))).toBe('kaboom')
  })

  test('exposes functions added after load', async () => {
    await app.exposeFunction('late', () => 'late-ok')
    await app.load('index.html')
    expect(must(await app.evaluate<string>('late()'))).toBe('late-ok')
  })

  test('accepts a serialized function with arguments', async () => {
    expect(must(await app.evaluate((a: number, b: number) => a * b, 6, 7))).toBe(42)
  })
})

describe('shadowing', () => {
  // Reported from ports-cli, where a page's own `async function kill` replaced
  // the exposed `kill` and the button called the page back instead of Bun.
  test('reports an exposed name the page declares over', async () => {
    await app.load('shadow.html')
    expect(must(await must(app.mainWindow()).shadowedFunctions())).toEqual(['add'])
    // The page really did take it over, which is what makes this silent.
    expect(must(await app.evaluate<string>('add(1, 2)'))).toBe('page')
  })

  test('stays quiet when the page wraps its script', async () => {
    await app.load('wrapped.html')
    expect(must(await must(app.mainWindow()).shadowedFunctions())).toEqual([])
    expect(must(await app.evaluate<number>('add(1, 2)'))).toBe(3)
  })

  test('stays quiet for a module script, whose declarations are scoped', async () => {
    await app.load('module.html')
    expect(must(await must(app.mainWindow()).shadowedFunctions())).toEqual([])
    expect(must(await app.evaluate<number>('add(1, 2)'))).toBe(3)
  })

  test('a reload reinstalls the bridge over the page', async () => {
    await app.load('index.html')
    expect(must(await must(app.mainWindow()).shadowedFunctions())).toEqual([])
  })
})

describe('multiple windows', () => {
  test('opens a second app window and keeps the bridge working', async () => {
    const second = must(await app.createWindow('nested.html'))
    try {
      expect(app.windows().length).toBe(2)
      expect(must(await second.evaluate<string>('document.getElementById("n").textContent'))).toBe('nested')
      expect(must(await second.evaluate<number>('add(4, 5)'))).toBe(9)
      expect(must(await second.evaluate<number>('outerHeight - innerHeight'))).toBeLessThan(MAX_APP_CHROME)
      // The main window is untouched.
      expect(must(await app.evaluate<string>('document.getElementById("t").textContent'))).toBe('hello')
    } finally {
      await second.close()
    }
    expect(app.windows().length).toBe(1)
  }, 60_000)
})

describe('scoped disposal', () => {
  test('await using exits the app at the end of the block', async () => {
    let seen: App | undefined
    {
      await using scoped = must(await launch({ width: 400, height: 300 }))
      seen = scoped
      expect(scoped.exited).toBe(false)
      expect(scoped.windows().length).toBe(1)
    }
    expect(seen.exited).toBe(true)
    expect(seen.windows().length).toBe(0)
  }, 60_000)

  test('await using exits the app even when the block throws', async () => {
    let seen: App | undefined
    await expect(
      (async () => {
        await using scoped = must(await launch({ width: 400, height: 300 }))
        seen = scoped
        throw new Error('boom')
      })(),
    ).rejects.toThrow('boom')
    expect(seen!.exited).toBe(true)
  }, 60_000)

  test('await using closes a window without exiting its app', async () => {
    let closed: Window | undefined
    {
      await using second = must(await app.createWindow('nested.html'))
      closed = second
      expect(app.windows().length).toBe(2)
    }
    expect(closed.closed).toBe(true)
    expect(app.windows().length).toBe(1)
    expect(app.exited).toBe(false)
  }, 60_000)
})

describe('failures are values', () => {
  test('a page-side throw comes back as EvaluationError', async () => {
    const result = await app.evaluate('throw new TypeError("nope")')
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error._tag).toBe('EvaluationError')
      expect(result.error.message).toContain('nope')
    }
  })

  test('an unfindable browser comes back as ChromeNotFoundError', async () => {
    const result = await launch({ executablePath: '/nonexistent/chrome' })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error._tag).toBe('ChromeNotFoundError')
      expect(ChromeNotFoundError.is(result.error)).toBe(true)
    }
  }, 60_000)

  test('operating on a closed app reports WindowClosedError', async () => {
    const solo = must(await launch({ width: 400, height: 300 }))
    solo.exit()

    const result = await solo.evaluate('1 + 1')
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error._tag).toBe('WindowClosedError')
  }, 60_000)

  test('errors match exhaustively by tag', async () => {
    const result = await launch({ executablePath: '/nonexistent/chrome' })
    const described = result.match({
      ok: () => 'launched',
      err: e =>
        e.match({
          ChromeNotFoundError: () => 'no browser',
          LaunchTimeoutError: () => 'timed out',
          BrowserGoneError: () => 'browser gone',
          ProtocolError: () => 'chrome refused a command',
        }),
    })
    expect(described).toBe('no browser')
  }, 60_000)
})

describe('the protocol layer', () => {
  test('a refused CDP command comes back as ProtocolError naming the method', async () => {
    const sent = await must(app.mainWindow()).session.send('NoSuch.method')
    expect(sent.isErr()).toBe(true)
    if (sent.isErr() && ProtocolError.is(sent.error)) {
      expect(sent.error.method).toBe('NoSuch.method')
    } else {
      throw new Error('expected a ProtocolError')
    }
  })

  test('a command on a dead connection comes back as BrowserGoneError', async () => {
    const solo = must(await launch({ width: 400, height: 300 }))
    const session = must(solo.mainWindow()).session
    solo.exit()

    const sent = await session.send('Runtime.evaluate', { expression: '1' })
    expect(sent.isErr()).toBe(true)
    if (sent.isErr()) expect(sent.error._tag).toBe('BrowserGoneError')
  }, 60_000)

  test('exposeFunction reports a window it could not reach', async () => {
    const solo = must(await launch({ width: 400, height: 300 }))
    solo.exit()

    const exposed = await solo.exposeFunction('late', () => 1)
    expect(exposed.isErr()).toBe(true)
    if (exposed.isErr()) expect(exposed.error._tag).toBe('BrowserGoneError')
  }, 60_000)
})

describe('lifecycle', () => {
  test('fires onExit when the app exits', async () => {
    const solo = must(await launch({ width: 400, height: 300 }))
    let exited = false
    solo.onExit(() => (exited = true))
    solo.exit()
    expect(exited).toBe(true)
    expect(solo.exited).toBe(true)
  }, 60_000)
})
