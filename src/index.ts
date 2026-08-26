/**
 * Build desktop applications with Bun and the Chrome already installed on the
 * machine.
 *
 * barlo is a port of [carlo](https://github.com/GoogleChromeLabs/carlo). Call
 * {@linkcode launch} to open a chrome-less Chrome window, serve your web app
 * into it with {@linkcode App.serveFolder} or {@linkcode App.serveEmbedded},
 * and bridge the two sides with {@linkcode App.exposeFunction}.
 *
 * @example Minimal application
 * ```ts
 * import { launch } from "barlo";
 *
 * const app = await launch({ title: "Hello", width: 800, height: 600 });
 *
 * app.serveFolder("./www");
 * await app.exposeFunction("cwd", () => process.cwd());
 * await app.load("index.html");
 * ```
 *
 * The page reaches back with `await window.cwd()`.
 *
 * @module
 */

import { App, type LaunchOptions } from './app'

export { App, type LaunchOptions } from './app'
export { Window, type Bounds, type ExposedFunction } from './window'
export { type EmbeddedFiles, type RequestHandler } from './server'
export { findChrome } from './find-chrome'

/**
 * Starts Chrome in app mode and returns the running application.
 *
 * Resolves once the window is open and its CDP session is ready, so routes and
 * exposed functions can be registered against the returned {@linkcode App}
 * before the first {@linkcode App.load}. Until then the window shows a blank
 * built-in page.
 *
 * On failure Chrome is killed and the HTTP server is stopped before the error
 * propagates, so a rejected call leaves nothing running.
 *
 * @param options Window geometry, Chrome selection, and profile settings.
 * @returns The application, with one open window.
 * @throws When no Chrome can be found, or when Chrome fails to start within
 * {@linkcode LaunchOptions.timeout} milliseconds.
 *
 * @example Serving a folder from disk
 * ```ts
 * import { launch } from "barlo";
 *
 * const app = await launch({ title: "Notes", width: 900, height: 700 });
 *
 * app.serveFolder("./www");
 * await app.load("index.html");
 * ```
 *
 * @example Pointing at an existing dev server
 * ```ts
 * import { launch } from "barlo";
 *
 * const app = await launch();
 *
 * app.serveOrigin("http://localhost:5173");
 * await app.load();
 * ```
 *
 * Requests are proxied to Vite, so hot reload keeps working inside the window.
 */
export async function launch(options: LaunchOptions = {}): Promise<App> {
  const app = new App(options)
  await app._start()
  return app
}

/**
 * The module's default export, for `import barlo from "barlo"`.
 *
 * Carries {@linkcode launch} only; named imports are preferred.
 */
export default { launch }
