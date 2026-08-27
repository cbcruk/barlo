# barlo

Build desktop applications with [Bun](https://bun.com) and the Chrome you already have.

barlo is a port of [GoogleChromeLabs/carlo](https://github.com/GoogleChromeLabs/carlo), which was
archived in April 2026. Same idea as the original: serve your web app from the runtime, open it in a
chrome-less Chrome window, and let the page call back into system-capable code. No bundled Chromium,
and — unlike Carlo — no dependencies at all.

```ts
import { launch } from 'barlo'

const app = await launch({ title: 'Hello', width: 800, height: 600 })

app.serveFolder('./www')
await app.exposeFunction('cwd', () => process.cwd())
await app.load('index.html')
```

```html
<script type="module">
  document.body.textContent = await window.cwd()
</script>
```

## Why not `Bun.WebView`?

This project started from the assumption that Bun 1.3.12's `Bun.WebView` could replace Carlo's
Puppeteer dependency and drive a desktop window directly. It cannot, and it is worth being explicit
about why:

- `Bun.WebView` is a **headless browser automation API** — a built-in Puppeteer, not a GUI toolkit.
  `new Bun.WebView({ headless: false })` throws `headless: false is not yet implemented`.
- Its `backend.argv` escape hatch does not help. Chrome decides it is headless from the *presence* of
  the `--headless` switch, so `--headless=false` still yields a `HeadlessChrome` user agent.
- Connecting it to a Chrome you launched yourself (`backend: { type: 'chrome', url }`) does open a
  live connection, but the view drives a target it creates via `Target.createTarget` — a normal
  tabbed window (~87px of toolbar), not your app window.

What Bun genuinely brings is everything *around* the window: a built-in HTTP server, a WebSocket
client good enough to speak CDP directly, and `bun build --compile`. So barlo spawns Chrome in app
mode itself and talks CDP over a ~120-line client. That is Carlo's architecture, minus Puppeteer.

## Install

Straight from GitHub, with no npm publish involved:

```sh
bun add github:cbcruk/barlo
npm install github:cbcruk/barlo
```

Pin a release by appending a tag — `github:cbcruk/barlo#v0.1.0`.

Generated declarations are committed to `dist/` precisely so that this works:
bun blocks lifecycle scripts by default and installs no devDependencies for git
dependencies, so nothing can build them at install time. CI fails if the
committed output drifts from the source.

Requires Bun and a locally installed Chrome, Chromium, Edge, or Brave. barlo checks the usual
per-platform locations and Playwright's browser cache; override with `BARLO_CHROME_PATH`.

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

- `app.serveFolder(folder, prefix?)` — files from disk, refusing paths that escape the folder.
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

#### The page can take the name back

A classic script's top-level `function` and `var` declarations become properties of `window`, which
is exactly where the bridge installs its functions. A page containing `function kill` replaces an
exposed `kill`, and the page's own calls then reach the page instead of Bun — silently, because the
call still returns a promise.

barlo cannot prevent it: locking the property down makes the page's declaration throw and kills the
script outright. So it detects it instead, warning after each load, with
`window.shadowedFunctions()` returning the names for a test to assert on.

Avoid it by wrapping the page's script so it declares nothing globally, using
`<script type="module">`, whose top-level declarations are module-scoped, or exposing under a name
the page does not declare — `__kill` rather than `kill`.

### Windows

`app.mainWindow()`, `app.windows()`, `app.createWindow(uri?)`, and on a `Window`:
`load`, `evaluate`, `screenshot`, `bounds`, `setBounds`, `fullscreen`, `maximize`, `minimize`,
`bringToFront`, `onClose`, `close`.

Multi-window works the way Carlo's did — re-running the Chrome binary against the same profile, which
the running browser process handles. CDP has no app-mode window type, so there is no better route.

### Lifecycle

`app.onExit(handler)` fires when the last window closes or Chrome quits. `app.exit()` tears down the
connection, the server, and Chrome, and removes the profile if barlo created it.

Both `App` and `Window` implement `Symbol.asyncDispose`, so a scope can own them:

```ts
{
  await using app = await launch()

  app.serveFolder('./www')
  await app.load('index.html')
}
// Chrome is gone here, even if the block threw.
```

## Single-file executables

```sh
bun build --compile app.ts --outfile myapp
```

`serveFolder` reads from disk and therefore **does not survive `--compile`** — a compiled binary has
no `www` folder next to it and every request 404s. Embed the assets instead:

```ts
import index from './www/index.html' with { type: 'text' }

app.serveEmbedded({ 'index.html': index as unknown as string })
```

(The cast is needed only because Bun types every `.html` import as an `HTMLBundle` for its bundler.)

The resulting binary is ~79 MB and needs no Node, no `node_modules`, and no Chromium — just the
browser already on the machine.

## Status and caveats

CI opens a real window on Linux, macOS, and Windows on every push, and each runner resolves its own
system browser — `/Applications/Google Chrome.app/...` on macOS,
`C:\Program Files\Google\Chrome\Application\chrome.exe` on Windows. The suite covers the app-mode
window, sizing, folder/embedded/handler serving, the RPC bridge across reloads and windows,
multi-window, and the compiled binary.

The window frame is the one thing that is genuinely platform-specific: `outerHeight - innerHeight` is
0-11 pixels on Linux, 32 on macOS, and 39 on Windows. And on macOS the height given to `setBounds` does not
round-trip: a window set to 700 comes back as 677 from both `window.bounds()` and the page, short by
the title bar. Width is exact everywhere, as is height on Linux and Windows.

Chrome's `--app` mode is the load-bearing assumption here, exactly as it was for Carlo. Google has
been narrowing that surface for years, and if it goes, this approach goes with it.

## Development

```sh
bun install
bun run typecheck    # tsc over src, test, and examples
bun run docs:check   # every export documented, every @example type-checks
bun run build        # emit dist/*.d.ts
bun test             # opens real Chrome windows; needs a display
```

On a headless machine, run the suite under Xvfb and point barlo at a browser:

```sh
bunx playwright install chromium
BARLO_CHROME_PATH=$(echo ~/.cache/ms-playwright/chromium-*/chrome-linux/chrome) \
  xvfb-run -a --server-args="-screen 0 1280x1024x24" bun test
```

### Packaging

The published package ships both the TypeScript source and generated
declarations. The `exports` map sends Bun to `src/index.ts`, so stack traces
point at real source and there is no bundle step at runtime, while `types`
resolves to `dist/index.d.ts`, so a consumer never type-checks barlo's
implementation. `prepack` rebuilds the declarations when packing, so a published
tarball never carries stale output.

`prepare` is deliberately not used: it would run on a git-dependency install,
where bun installs no devDependencies, and would fail for any consumer who
trusts the script.

Releases run from a `v*` tag, which the workflow checks against the version in
`package.json`. Publishing needs an `NPM_TOKEN` repository secret.

## License

Apache-2.0, matching Carlo.
