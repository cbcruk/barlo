# barlo

Build desktop applications with [Node.js](https://nodejs.org) and the Chrome you already have.

barlo is a port of [GoogleChromeLabs/carlo](https://github.com/GoogleChromeLabs/carlo), which was
archived in April 2026. Same idea as the original: serve your web app from the runtime, open it in a
chrome-less Chrome window, and let the page call back into system-capable code. No bundled Chromium,
and — unlike Carlo — no Puppeteer and no browser download. Its one dependency is
[better-result](https://github.com/dmmulroy/better-result), because failures are values here rather
than exceptions.

```ts
import { launch } from 'barlo'

const app = (await launch({ title: 'Hello', width: 800, height: 600 })).unwrap()

app.serveFolder('./www')
await app.exposeFunction('cwd', () => process.cwd())
await app.load('index.html')
```

```html
<script type="module">
  document.body.textContent = await window.cwd()
</script>
```

## How it works

barlo spawns Chrome in app mode itself, serves the application from a `node:http` server on
`127.0.0.1`, and talks the Chrome DevTools Protocol through a ~120-line client on Node's built-in
`WebSocket`. That is Carlo's architecture, minus Puppeteer.

barlo was first written for Bun, on the hope that `Bun.WebView` could drive a desktop window. It
cannot — it is a headless automation API, and `headless: false` is not implemented — and apart
from `bun build --compile` the Bun version used nothing Node lacks, so requiring Bun was only a
cost.

## Install

```sh
npm install barlo
```

Requires Node.js 24 or later and a locally installed Chrome, Chromium, Edge, or Brave. barlo checks
the usual per-platform locations and Playwright's browser cache; override with `BARLO_CHROME_PATH`.

## API

### `launch(options?): Promise<App>`

| Option | Default | Notes |
| --- | --- | --- |
| `title` | — | Applied after every navigation, overriding the document title |
| `width` / `height` | `800` / `600` | Initial window size |
| `left` / `top` | — | Initial window position |
| `executablePath` | auto-detected | Chrome binary |
| `args` | `[]` | Extra Chrome switches, appended last |
| `userDataDir` | temporary | Pass a stable path to persist cookies and localStorage |
| `verbose` | `false` | Forward Chrome's stderr, for when Chrome dies silently |
| `timeout` | `20000` | Milliseconds to wait for Chrome to come up |

### Serving

- `app.serveFolder(folder, prefix?)` — files from disk, refusing paths that escape the folder. The
  content type comes from the file extension.
- `app.serveEmbedded(files, prefix?)` — an in-memory `path -> contents` map.
- `app.serveOrigin(base, prefix?)` — reverse-proxy a prefix onto a remote origin, e.g. a dev server.
- `app.serveHandler(handler)` — a `Request => Response | undefined` fallthrough handler.

Longer prefixes win; returning `undefined` falls through to the next route.

### Bridge

- `app.exposeFunction(name, fn)` — makes `fn` callable from the page as `window[name]`, returning a
  promise. Arguments and results round-trip as JSON; thrown errors reject on the page side. Names
  exposed after load land on the current document too, without a reload.
- `window.shadowedFunctions()` — exposed names the page has taken back (see below).
- `app.evaluate(fnOrExpression, ...args)` — run code in the page and get the value back.
- `app.provideFile(selector, paths)` — put files on disk into an `<input type="file">` in the page, for
  files too large for the bridge (see below).

### Failures are values

Nothing in barlo throws. Every fallible call returns a `Result`, so what can go wrong is in the
signature and the compiler makes you deal with it:

```ts
const launched = await launch()

launched.match({
  ok: app => app.serveFolder('./www'),
  err: e =>
    e.match({
      ChromeNotFoundError: () => console.error('Install Google Chrome.'),
      LaunchTimeoutError: t => console.error(`Chrome stalled at ${t.phase}.`),
      BrowserGoneError: () => console.error('Chrome exited during startup.'),
      ProtocolError: e => console.error(`Chrome refused ${e.method}.`),
    }),
})
```

`match` over the error union is exhaustive, so a new failure mode becomes a compile error at every
call site rather than a surprise at runtime. This goes all the way down: `window.session.send()`,
the raw CDP escape hatch, returns a `Result` too, so nothing in barlo throws and nothing swallows a
failure to keep a signature tidy. Narrow with `_tag`, `ChromeNotFoundError.is(e)`, or
`match`; `unwrap()` when a failure genuinely should stop the program, `unwrapOr(fallback)` when it
should not.

The failures are `ChromeNotFoundError`, `LaunchTimeoutError`, `BrowserGoneError`,
`WindowClosedError`, `NavigationError`, `EvaluationError`, and `ProtocolError` — all exported, all
tagged, all carrying the fields that make them actionable rather than a message to parse.

#### The page can take the name back

A classic script's top-level `function` and `var` declarations become properties of `window`, which
is exactly where the bridge installs its functions. A page containing `function kill` replaces an
exposed `kill`, and the page's own calls then reach the page instead of Node — silently, because the
call still returns a promise.

barlo cannot prevent it: locking the property down makes the page's declaration throw and kills the
script outright. So it detects it instead, warning after each load, with
`window.shadowedFunctions()` returning the names for a test to assert on.

Avoid it by wrapping the page's script so it declares nothing globally, using
`<script type="module">`, whose top-level declarations are module-scoped, or exposing under a name
the page does not declare — `__kill` rather than `kill`.

#### The bridge belongs to the window, not the page

Exposed functions are installed per window, not per document: CDP's binding and
new-document script reach every frame the tab ever shows, including a page it
navigates to and a cross-origin `<iframe>`. So barlo records the origin of each
execution context and answers a call only when it comes from the application's
origin; anything else is dropped without running the function. Replies go back
to the calling context alone, never to whatever document replaced it.

`load()` and `createWindow()` also refuse a target outside the application's
origin, since a window pointed at a remote site would only be a window without a
bridge.

#### The origin is the boundary

Every document on the application's origin can call every exposed function. That
includes documents the application never served but which inherit its origin: a
`blob:` URL the page opens, an `about:blank` or `srcdoc` frame it builds, and a
popup it opens with `window.open()`. Even if barlo refused their direct calls,
they could reach the bridge through `parent`, `opener`, or a served page they
frame, since same-origin documents share everything. So barlo does not try to
tell them apart.

To show content you do not trust, such as a file the user is previewing, give it
an opaque origin: an `<iframe sandbox>` **without** `allow-same-origin` or
`allow-popups-to-escape-sandbox`, filled with `srcdoc`. Never show it through an
unsandboxed `blob:` URL, in a frame or a window. A sandboxed frame can still
`postMessage` the page, so validate any message the page listens for.

#### Large files go through a file input, not the bridge

Exposed functions answer through `Runtime.evaluate` as JSON, which slows down
sharply with size — 8 MB takes about half a second, 100 MB about a minute — and
holds up every other call meanwhile. `window.provideFile(selector, paths)`
instead puts files on disk into an `<input type="file">` in the page, as if the
user had picked them, and Chrome reads them straight from disk. Only the
top-level document on the application's origin is ever given a file.

The page can read whatever is passed, so check the paths first. The top-document
check only guards against mistakes: by the rule above, any same-origin document
can reach the input or the bridge. A `blob:` URL made from one of these files
shares the application's origin, so an HTML or SVG file shown through it can
call every exposed function. Retype blobs with a MIME type you checked, show
images through `<img>`, and show documents as described in "The origin is the
boundary".

### Windows

`app.mainWindow()`, `app.windows()`, `app.createWindow(uri?)`, and on a `Window`:
`load`, `evaluate`, `provideFile`, `screenshot`, `bounds`, `setBounds`, `fullscreen`, `maximize`, `minimize`,
`bringToFront`, `onClose`, `close`.

Multi-window works the way Carlo's did — re-running the Chrome binary against the same profile, which
the running browser process handles. CDP has no app-mode window type, so there is no better route.

### Lifecycle

`app.onExit(handler)` fires when the last window closes or Chrome quits. `app.exit()` tears down the
connection, the server, and Chrome, and removes the profile if barlo created it.

Both `App` and `Window` implement `Symbol.asyncDispose`, so a scope can own them:

```ts
{
  await using app = (await launch()).unwrap()

  app.serveFolder('./www')
  await app.load('index.html')
}
// Chrome is gone here, even if the block threw.
```

## Status and caveats

CI opens a real window on Linux, macOS, and Windows on every push, and each runner resolves its own
system browser — `/Applications/Google Chrome.app/...` on macOS,
`C:\Program Files\Google\Chrome\Application\chrome.exe` on Windows. The suite covers the app-mode
window, sizing, folder/embedded/handler/proxy serving, the RPC bridge across reloads and windows,
and multi-window.

The window frame is the one thing that is genuinely platform-specific: `outerHeight - innerHeight` is
0-11 pixels on Linux, 32 on macOS, and 39 on Windows. And on macOS the height given to `setBounds` does not
round-trip: a window set to 700 comes back as 677 from both `window.bounds()` and the page, short by
the title bar. Width is exact everywhere, as is height on Linux and Windows.

Chrome's `--app` mode is the load-bearing assumption here, exactly as it was for Carlo. Google has
been narrowing that surface for years, and if it goes, this approach goes with it.

## Development

```sh
npm install
npm run typecheck    # tsc over src, test, examples, and scripts
npm run docs:check   # every export documented, every @example type-checks
npm run build        # emit dist/*.js and dist/*.d.ts
npm test             # opens real Chrome windows; needs a display
```

The source runs directly under Node's type stripping, so the tests, the example, and the scripts
need no build step. That is why relative imports carry their `.ts` extension, which the build
rewrites to `.js`, and why the source sticks to erasable TypeScript syntax (`erasableSyntaxOnly`).

On a headless machine, run the suite under Xvfb and point barlo at a browser:

```sh
npx playwright install chromium
BARLO_CHROME_PATH=$(echo ~/.cache/ms-playwright/chromium-*/chrome-linux/chrome) \
  xvfb-run -a --server-args="-screen 0 1280x1024x24" npm test
```

### Packaging

The published package runs from `dist/`, compiled JavaScript with declarations, because Node does
not strip types from files under `node_modules`. The TypeScript source ships alongside it so source
maps and go-to-definition land on real code. `prepack` rebuilds `dist/` when packing, so a
published tarball never carries stale output and `dist/` never enters git.

Installing from GitHub — `npm install github:cbcruk/barlo` — does not work for the same reason:
`dist/` is not committed. `prepare` is deliberately not used to build it at install time, since it
would need devDependencies the consumer does not have. Use the registry.

Releases run from a `v*` tag, which the workflow checks against the version in
`package.json`. Publishing authenticates with npm trusted publishing over OIDC
rather than a stored token, so the release workflow holds no secret and npm
attaches a provenance attestation to every version. The trusted publisher
configured on npm names `.github/workflows/release.yml`, so renaming that file
means updating the entry on npmjs.com too.

## License

Apache-2.0, matching Carlo.
