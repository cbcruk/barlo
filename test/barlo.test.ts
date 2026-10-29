import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { gzipSync } from 'node:zlib'

import type { Result } from 'better-result'

import { ChromeNotFoundError, ProtocolError, launch, type App, type Window } from '../src/index.ts'
import { AppServer } from '../src/server.ts'

/**
 * Unwraps a Result in a test, failing with the tagged error rather than a
 * `Panic` that hides which failure it was.
 */
/**
 * Launch timeout for the suite.
 *
 * The product default is 20s, which suits a desktop. CI runs three jobs on two
 * cores and this suite starts Chrome seven times, so a slow start there is
 * contention rather than the failure the test is looking for.
 */
const LAUNCH_TIMEOUT = 60_000

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
  join(www, 'picker.html'),
  `<!doctype html><input type="file" id="pick"><p id="not-an-input"></p>
  <input type="file" id="many" multiple>
  <script>
    globalThis.events = []
    pick.addEventListener('input', () => events.push('input'))
    pick.addEventListener('change', () => events.push('change'))
  </script>`,
)
// Large enough that sending it as an exposed function's result would take seconds.
const bigFile = join(www, 'big.bin')
writeFileSync(bigFile, Buffer.alloc(16 * 1024 * 1024, 7))
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

before(async () => {
  app = must(await launch({ width: 640, height: 480, title: 'Barlo Test', timeout: LAUNCH_TIMEOUT }))
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
})

after(() => app?.exit())

describe('window', () => {
  test('opens a real, non-headless window', async () => {
    assert.ok(!must(await app.evaluate<string>('navigator.userAgent')).includes('Headless'))
  })

  test('runs in app mode with no browser chrome', async () => {
    assert.ok(must(await app.evaluate<number>('outerHeight - innerHeight')) < MAX_APP_CHROME)
  })

  test('honours the requested size', async () => {
    assert.equal(must(await app.evaluate<string>('[outerWidth, outerHeight].join("x")')), '640x480')
  })

  test('applies the configured title over the document title', async () => {
    assert.equal(must(await app.evaluate<string>('document.title')), 'Barlo Test')
  })

  test('resizes via bounds', async () => {
    await must(app.mainWindow()).setBounds({ width: 900, height: 700 })
    await sleep(300)

    const bounds = must(await must(app.mainWindow()).bounds())
    assert.equal(bounds.width, 900)
    assert.equal(must(await app.evaluate<number>('outerWidth')), 900)

    // Height does not round-trip on macOS: asking for 700 yields 677, short by
    // the title bar, and both `bounds()` and `outerHeight` agree on 677. Every
    // other platform is exact, so the allowance is one title bar, not a range.
    assert.ok(700 - bounds.height >= 0)
    assert.ok(700 - bounds.height <= 30)
    assert.equal(must(await app.evaluate<number>('outerHeight')), bounds.height)
  })
})

describe('serving', () => {
  test('serves the folder', async () => {
    assert.equal(must(await app.evaluate<string>('document.getElementById("t").textContent')), 'hello')
  })

  test('navigates to another served file', async () => {
    await app.load('nested.html')
    assert.equal(must(await app.evaluate<string>('document.getElementById("n").textContent')), 'nested')
    await app.load('index.html')
  })

  test('serves an embedded file map', async () => {
    assert.equal(must(await app.evaluate<string>('fetch("/embedded/hi.txt").then(r => r.text())')), 'embedded!')
  })

  test('falls through to a custom handler', async () => {
    assert.equal(must(await app.evaluate<string>('fetch("/api/ping").then(r => r.text())')), 'pong')
  })

  test('refuses paths escaping the served folder', async () => {
    assert.equal(must(await app.evaluate<number>('fetch("/../../etc/passwd").then(r => r.status)')), 404)
  })
})

describe('serving failures', () => {
  // Each of these used to reach the window as a runtime's error page. They
  // exercise AppServer directly: the behaviour is the server's, and a browser
  // per case would only add Chrome instances the suite does not need.
  test('a path that cannot be decoded is declined, not fatal', async () => {
    assert.equal(must(await app.evaluate<number>('fetch("/%ZZ").then(r => r.status)')), 404)
  })

  test('an upstream that is not listening falls through', async () => {
    const server = new AppServer()
    // Nothing listens on port 1, which is the ordinary case for a dev-server
    // proxy started before its dev server.
    server.serveOrigin('http://127.0.0.1:1', '/proxy')
    const origin = await server.listen()
    try {
      assert.equal((await fetch(`${origin}/proxy/x`)).status, 404)
    } finally {
      server.stop()
    }
  })

  test('a handler that throws answers 500 rather than an error page', async () => {
    const server = new AppServer()
    server.serveHandler(() => {
      throw new Error('handler bug')
    })
    const origin = await server.listen()
    try {
      const response = await fetch(origin)
      assert.equal(response.status, 500)
      // Not an HTML error page with a stack trace in it.
      assert.equal(await response.text(), 'Internal error')
    } finally {
      server.stop()
    }
  })

  test('a malformed path reaches no route at all', async () => {
    const server = new AppServer()
    server.serveEmbedded({ 'index.html': 'hello' })
    const origin = await server.listen()
    try {
      assert.equal((await fetch(`${origin}/%ZZ`)).status, 404)
      assert.equal((await fetch(`${origin}/`)).status, 200)
    } finally {
      server.stop()
    }
  })
})

describe('serveOrigin', () => {
  // A dev server stand-in that compresses its answers and echoes what reached it.
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const echoed = JSON.stringify({
        method: request.method,
        path: request.url,
        host: request.headers.host,
        body: Buffer.concat(chunks).toString(),
      })
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      response.end(gzipSync(echoed))
    })
  })
  let upstreamOrigin = ''
  before(async () => {
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  })
  after(() => {
    upstream.close()
    upstream.closeAllConnections()
  })

  test('forwards a streamed body and decodes the response once', async () => {
    const server = new AppServer()
    server.serveOrigin(upstreamOrigin, '/dev')
    const origin = await server.listen()
    try {
      // Sent with `connection: keep-alive`, which Node's fetch refuses to forward.
      const response = await fetch(`${origin}/dev/api?x=1`, { method: 'POST', body: 'payload' })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), {
        method: 'POST',
        path: '/api?x=1',
        host: new URL(upstreamOrigin).host,
        body: 'payload',
      })
    } finally {
      server.stop()
    }
  })
})

describe('exposeFunction', () => {
  test('round-trips arguments and return values', async () => {
    assert.equal(must(await app.evaluate<number>('add(2, 3)')), 5)
  })

  test('survives a reload', async () => {
    await app.load('index.html')
    assert.equal(must(await app.evaluate<number>('add(10, 20)')), 30)
  })

  test('propagates errors to the page', async () => {
    assert.equal(must(await app.evaluate<string>('boom().then(() => "no throw", e => e.message)')), 'kaboom')
  })

  test('exposes functions added after load', async () => {
    await app.exposeFunction('late', () => 'late-ok')
    await app.load('index.html')
    assert.equal(must(await app.evaluate<string>('late()')), 'late-ok')
  })

  test('accepts a serialized function with arguments', async () => {
    assert.equal(must(await app.evaluate((a: number, b: number) => a * b, 6, 7)), 42)
  })
})

describe('shadowing', () => {
  // Reported from ports-cli, where a page's own `async function kill` replaced
  // the exposed `kill` and the button called the page back instead of Node.
  test('reports an exposed name the page declares over', async () => {
    await app.load('shadow.html')
    assert.deepEqual(must(await must(app.mainWindow()).shadowedFunctions()), ['add'])
    // The page really did take it over, which is what makes this silent.
    assert.equal(must(await app.evaluate<string>('add(1, 2)')), 'page')
  })

  test('stays quiet when the page wraps its script', async () => {
    await app.load('wrapped.html')
    assert.deepEqual(must(await must(app.mainWindow()).shadowedFunctions()), [])
    assert.equal(must(await app.evaluate<number>('add(1, 2)')), 3)
  })

  test('stays quiet for a module script, whose declarations are scoped', async () => {
    await app.load('module.html')
    assert.deepEqual(must(await must(app.mainWindow()).shadowedFunctions()), [])
    assert.equal(must(await app.evaluate<number>('add(1, 2)')), 3)
  })

  test('a reload reinstalls the bridge over the page', async () => {
    await app.load('index.html')
    assert.deepEqual(must(await must(app.mainWindow()).shadowedFunctions()), [])
  })
})

describe('multiple windows', () => {
  test('opens a second app window and keeps the bridge working', async () => {
    const second = must(await app.createWindow('nested.html'))
    try {
      assert.equal(app.windows().length, 2)
      assert.equal(must(await second.evaluate<string>('document.getElementById("n").textContent')), 'nested')
      assert.equal(must(await second.evaluate<number>('add(4, 5)')), 9)
      assert.ok(must(await second.evaluate<number>('outerHeight - innerHeight')) < MAX_APP_CHROME)
      // The main window is untouched.
      assert.equal(must(await app.evaluate<string>('document.getElementById("t").textContent')), 'hello')
    } finally {
      await second.close()
    }
    assert.equal(app.windows().length, 1)
  })
})

describe('provideFile', () => {
  test('hands a file to the input without sending it over the bridge', async () => {
    must(await app.load('picker.html'))
    const started = performance.now()
    must(await app.provideFile('#pick', [bigFile]))
    const read = must(
      await app.evaluate<unknown>(async () => {
        const file = (document.getElementById('pick') as HTMLInputElement).files![0]!
        const bytes = new Uint8Array(await file.arrayBuffer())
        return { name: file.name, size: file.size, first: bytes[0], events: (globalThis as any).events }
      }),
    )
    assert.deepEqual(read, {
      name: 'big.bin',
      size: 16 * 1024 * 1024,
      first: 7,
      events: ['input', 'change'],
    })
    assert.ok(performance.now() - started < 5_000)
  })

  test('refuses paths Chrome would accept but cannot read', async () => {
    must(await app.load('picker.html'))
    for (const paths of [['big.bin'], [join(www, 'missing.bin')], [www]]) {
      const result = await app.provideFile('#pick', paths)
      assert.equal(result.isErr(), true)
      if (result.isErr()) assert.equal(result.error._tag, 'EvaluationError')
    }
    assert.equal(must(await app.evaluate<number>('pick.files.length')), 0)
    // The window still works afterwards, which a relative path used to break.
    must(await app.load('index.html'))
  })

  test('gives several files only to an input that takes several', async () => {
    must(await app.load('picker.html'))
    assert.equal((await app.provideFile('#pick', [bigFile, bigFile])).isErr(), true)
    must(await app.provideFile('#many', [bigFile, join(www, 'index.html')]))
    assert.equal(must(await app.evaluate<number>('many.files.length')), 2)
  })

  test('refuses an element that is not a file input', async () => {
    must(await app.load('picker.html'))
    for (const selector of ['#not-an-input', '#missing', '!!not a selector']) {
      const result = await app.provideFile(selector, [bigFile])
      assert.equal(result.isErr(), true)
      if (result.isErr()) assert.equal(result.error._tag, 'EvaluationError')
    }
  })
})

describe('the bridge answers only its own origin', () => {
  // Counts calls that reached Node at all, since a foreign frame getting no
  // answer is not enough: the function must not have run.
  let probed = 0
  before(async () => {
    must(await app.exposeFunction('probe', () => ++probed))
  })

  // A second origin on another port. Its page tries the bridge and reports
  // whether it got an answer, which is what an HTML preview or an embedded
  // remote page would be able to do.
  const foreign = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    // An app-origin page holding a file input, framed by a foreign top document.
    const app = new URL(request.url ?? '/', 'http://localhost').searchParams.get('app')
    if (app) {
      response.end(`<!doctype html><iframe src="${app}/picker.html"></iframe>`)
      return
    }
    response.end(
      `<!doctype html><script>
        const answer = Promise.race([
          probe(),
          new Promise(resolve => setTimeout(() => resolve('ignored'), 500)),
        ])
        answer.then(value => parent !== window && parent.postMessage(value, '*'))
        globalThis.answer = answer
      </script>`,
    )
  })
  let foreignOrigin = ''
  before(async () => {
    await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', resolve))
    foreignOrigin = `http://127.0.0.1:${(foreign.address() as AddressInfo).port}`
  })
  after(() => {
    foreign.close()
    foreign.closeAllConnections()
  })

  async function waitForOrigin(origin: string): Promise<void> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const now = await app.evaluate<string>('location.origin + " " + document.readyState')
      if (now.isOk() && now.unwrap() === `${origin} complete`) return
      await sleep(50)
    }
    throw new Error(`the window never reached ${origin}`)
  }

  test('a window navigated off-origin by the page gets no answers', async () => {
    await app.evaluate(`location.href = ${JSON.stringify(`${foreignOrigin}/`)}`)
    await waitForOrigin(foreignOrigin)
    try {
      assert.equal(must(await app.evaluate<string>('answer')), 'ignored')
    } finally {
      must(await app.load('index.html'))
    }
    assert.equal(probed, 0)
    assert.equal(must(await app.evaluate<number>('probe()')), 1)
    probed = 0
  })

  test('an off-origin frame inside the app gets no answers', async () => {
    const answer = await app.evaluate<unknown>(
      (src: string) =>
        new Promise(resolve => {
          addEventListener('message', event => resolve(event.data), { once: true })
          document.body.append(Object.assign(document.createElement('iframe'), { src }))
        }),
      `${foreignOrigin}/`,
    )
    assert.equal(must(answer), 'ignored')
    assert.equal(probed, 0)
  })

  test('provideFile gives nothing to a window that navigated off-origin', async () => {
    await app.evaluate(`location.href = ${JSON.stringify(`${foreignOrigin}/`)}`)
    await waitForOrigin(foreignOrigin)
    try {
      must(await app.evaluate(() => document.body.append(Object.assign(document.createElement('input'), { type: 'file', id: 'pick' }))))
      const result = await app.provideFile('#pick', [bigFile])
      assert.equal(result.isErr(), true)
      assert.equal(must(await app.evaluate<number>('document.getElementById("pick").files.length')), 0)
    } finally {
      must(await app.load('index.html'))
    }
  })

  test('provideFile ignores an app-origin frame inside a foreign page', async () => {
    const appOrigin = must(await app.evaluate<string>('location.origin'))
    await app.evaluate(`location.href = ${JSON.stringify(`${foreignOrigin}/?app=${appOrigin}`)}`)
    await waitForOrigin(foreignOrigin)
    try {
      const deadline = Date.now() + 10_000
      while (!must(await app.evaluate<boolean>('frames.length > 0'))) {
        if (Date.now() > deadline) throw new Error('the frame never appeared')
        await sleep(50)
      }
      // The frame's own document loads after its element appears.
      await sleep(500)
      assert.equal((await app.provideFile('#pick', [bigFile])).isErr(), true)
    } finally {
      must(await app.load('index.html'))
    }
  })

  test('provideFile looks only at the top document, not into frames', async () => {
    const framed = await app.evaluate<unknown>(
      (src: string) =>
        new Promise(resolve => {
          const frame = Object.assign(document.createElement('iframe'), { src })
          frame.onload = () => resolve(true)
          document.body.append(frame)
        }),
      `${foreignOrigin}/`,
    )
    assert.equal(must(framed), true)
    const result = await app.provideFile('input[type=file]', [bigFile])
    assert.equal(result.isErr(), true)
  })

  test('createWindow refuses to open off-origin', async () => {
    const result = await app.createWindow(`${foreignOrigin}/`)
    assert.equal(result.isErr(), true)
    if (result.isErr()) assert.equal(result.error._tag, 'NavigationError')
    assert.equal(app.windows().length, 1)
  })
})

describe('scoped disposal', () => {
  test('await using exits the app at the end of the block', async () => {
    let seen: App | undefined
    {
      await using scoped = must(await launch({ width: 400, height: 300, timeout: LAUNCH_TIMEOUT }))
      seen = scoped
      assert.equal(scoped.exited, false)
      assert.equal(scoped.windows().length, 1)
    }
    assert.equal(seen.exited, true)
    assert.equal(seen.windows().length, 0)
  })

  test('await using exits the app even when the block throws', async () => {
    let seen: App | undefined
    await assert.rejects((async () => {
        await using scoped = must(await launch({ width: 400, height: 300, timeout: LAUNCH_TIMEOUT }))
        seen = scoped
        throw new Error('boom')
      })(), { message: 'boom' })
    assert.equal(seen!.exited, true)
  })

  test('await using closes a window without exiting its app', async () => {
    let closed: Window | undefined
    {
      await using second = must(await app.createWindow('nested.html'))
      closed = second
      assert.equal(app.windows().length, 2)
    }
    assert.equal(closed.closed, true)
    assert.equal(app.windows().length, 1)
    assert.equal(app.exited, false)
  })
})

describe('failures are values', () => {
  test('a page-side throw comes back as EvaluationError', async () => {
    const result = await app.evaluate('throw new TypeError("nope")')
    assert.equal(result.isErr(), true)
    if (result.isErr()) {
      assert.equal(result.error._tag, 'EvaluationError')
      assert.ok(result.error.message.includes('nope'))
    }
  })

  test('an unfindable browser comes back as ChromeNotFoundError', async () => {
    const result = await launch({ executablePath: '/nonexistent/chrome' })
    assert.equal(result.isErr(), true)
    if (result.isErr()) {
      assert.equal(result.error._tag, 'ChromeNotFoundError')
      assert.equal(ChromeNotFoundError.is(result.error), true)
    }
  })

  test('operating on a closed app reports WindowClosedError', async () => {
    const solo = must(await launch({ width: 400, height: 300, timeout: LAUNCH_TIMEOUT }))
    solo.exit()

    const result = await solo.evaluate('1 + 1')
    assert.equal(result.isErr(), true)
    if (result.isErr()) assert.equal(result.error._tag, 'WindowClosedError')
  })

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
    assert.equal(described, 'no browser')
  })
})

describe('inputs that used to escape as exceptions', () => {
  test('an exposed function returning a cyclic value rejects the page, not hangs it', async () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic['self'] = cyclic
    await app.exposeFunction('cyclic', () => cyclic)
    await app.load('index.html')

    // The page has to settle. Before, JSON.stringify threw while building the
    // reply and the promise was left pending forever.
    const outcome = must(
      await app.evaluate<string>('cyclic().then(() => "resolved", e => "rejected: " + e.message)'),
    )
    assert.ok(outcome.includes('rejected:'))
    assert.ok(outcome.includes('could not send the result back'))
  })

  test('a cyclic argument to evaluate is an error, not a throw', async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic

    const result = await app.evaluate((x: unknown) => x, cyclic)
    assert.equal(result.isErr(), true)
    if (result.isErr()) assert.equal(result.error._tag, 'EvaluationError')
  })

  test('cyclic CDP params are an error, not a throw', async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic

    const sent = await must(app.mainWindow()).session.send('Runtime.evaluate', cyclic)
    assert.equal(sent.isErr(), true)
    if (sent.isErr()) assert.equal(sent.error._tag, 'ProtocolError')
  })

  test('load refuses to leave the application origin', async () => {
    // The bridge is installed per window, not per document, so a window that
    // navigates away takes the exposed functions with it.
    const before = must(await app.evaluate<string>('location.origin'))

    const result = await app.load('http://example.com/evil')
    assert.equal(result.isErr(), true)
    if (result.isErr()) assert.equal(result.error._tag, 'NavigationError')
    assert.equal(must(await app.evaluate<string>('location.origin')), before)
  })

  test('a relative path with odd characters still loads', async () => {
    // Refusing off-origin must not refuse the ordinary.
    assert.equal((await app.load('index.html', { q: 'a b&c' })).isOk(), true)
    assert.ok(must(await app.evaluate<string>('location.search')).includes('a+b%26c'))
  })
})

describe('the protocol layer', () => {
  test('a refused CDP command comes back as ProtocolError naming the method', async () => {
    const sent = await must(app.mainWindow()).session.send('NoSuch.method')
    assert.equal(sent.isErr(), true)
    if (sent.isErr() && ProtocolError.is(sent.error)) {
      assert.equal(sent.error.method, 'NoSuch.method')
    } else {
      throw new Error('expected a ProtocolError')
    }
  })

  test('a command on a dead connection comes back as BrowserGoneError', async () => {
    const solo = must(await launch({ width: 400, height: 300, timeout: LAUNCH_TIMEOUT }))
    const session = must(solo.mainWindow()).session
    solo.exit()

    const sent = await session.send('Runtime.evaluate', { expression: '1' })
    assert.equal(sent.isErr(), true)
    if (sent.isErr()) assert.equal(sent.error._tag, 'BrowserGoneError')
  })

  test('exposeFunction reports a window it could not reach', async () => {
    const solo = must(await launch({ width: 400, height: 300, timeout: LAUNCH_TIMEOUT }))
    solo.exit()

    const exposed = await solo.exposeFunction('late', () => 1)
    assert.equal(exposed.isErr(), true)
    if (exposed.isErr()) assert.equal(exposed.error._tag, 'BrowserGoneError')
  })
})

describe('lifecycle', () => {
  test('fires onExit when the app exits', async () => {
    const solo = must(await launch({ width: 400, height: 300, timeout: LAUNCH_TIMEOUT }))
    let exited = false
    solo.onExit(() => (exited = true))
    solo.exit()
    assert.equal(exited, true)
    assert.equal(solo.exited, true)
  })
})
