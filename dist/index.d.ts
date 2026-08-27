/**
 * Build desktop applications with Bun and the Chrome already installed on the
 * machine.
 *
 * barlo is a port of [carlo](https://github.com/GoogleChromeLabs/carlo). Call
 * {@linkcode launch} to open a chrome-less Chrome window, serve your web app
 * into it with {@linkcode App.serveFolder} or {@linkcode App.serveEmbedded},
 * and bridge the two sides with {@linkcode App.exposeFunction}.
 *
 * Every fallible call returns a `Result` rather than throwing, so failures are
 * in the signature. See {@linkcode BarloError} for what they can be.
 *
 * @example Minimal application
 * ```ts
 * import { launch } from "barlo";
 *
 * const app = (await launch({ title: "Hello", width: 800, height: 600 })).unwrap();
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
import type { Result } from 'better-result';
import { App, type LaunchOptions } from './app';
import type { LaunchError } from './errors';
export { App, type LaunchOptions } from './app';
export { BrowserGoneError, ChromeNotFoundError, EvaluationError, LaunchTimeoutError, NavigationError, ProtocolError, WindowClosedError, type BarloError, type EvaluateError, type LaunchError, type LaunchPhase, type LoadError, type WindowError, } from './errors';
export { Window, type Bounds, type ExposedFunction } from './window';
export { type EmbeddedFiles, type RequestHandler } from './server';
export { findChrome } from './find-chrome';
/**
 * Starts Chrome in app mode and returns the running application.
 *
 * Resolves once the window is open and its CDP session is ready, so routes and
 * exposed functions can be registered against the returned {@linkcode App}
 * before the first {@linkcode App.load}. Until then the window shows a blank
 * built-in page.
 *
 * On failure Chrome is killed and the HTTP server is stopped before the error
 * is returned, so a failed launch leaves nothing running.
 *
 * @param options Window geometry, Chrome selection, and profile settings.
 * @returns The application with one open window, or why it could not start:
 * {@linkcode ChromeNotFoundError} when no browser is installed,
 * {@linkcode LaunchTimeoutError} when one is but never came up.
 *
 * @example Reporting a failure instead of crashing
 * ```ts
 * import { launch } from "barlo";
 *
 * const launched = await launch({ title: "Notes", width: 900, height: 700 });
 * if (launched.isErr()) {
 *   console.error(launched.error.message);
 *   process.exit(1);
 * }
 *
 * const app = launched.unwrap();
 *
 * app.serveFolder("./www");
 * await app.load("index.html");
 * ```
 *
 * @example Handling each failure differently
 * ```ts
 * import { launch } from "barlo";
 *
 * const launched = await launch();
 *
 * launched.match({
 *   ok: (app) => app.serveOrigin("http://localhost:5173"),
 *   err: (e) =>
 *     e.match({
 *       ChromeNotFoundError: () => console.error("Install Google Chrome."),
 *       LaunchTimeoutError: (t) => console.error(`Chrome stalled at ${t.phase}.`),
 *       BrowserGoneError: () => console.error("Chrome exited during startup."),
 *     }),
 * });
 * ```
 *
 * Requests are proxied to Vite, so hot reload keeps working inside the window.
 */
export declare function launch(options?: LaunchOptions): Promise<Result<App, LaunchError>>;
/**
 * The module's default export, for `import barlo from "barlo"`.
 *
 * Carries {@linkcode launch} only; named imports are preferred.
 */
declare const _default: {
    launch: typeof launch;
};
export default _default;
//# sourceMappingURL=index.d.ts.map