/**
 * Locates a locally installed Chrome, Chromium, Edge, or Brave.
 *
 * barlo never bundles a browser — that was Carlo's whole point, and it is what
 * keeps a compiled app in the tens of megabytes instead of hundreds.
 *
 * @module
 */
import { Result } from 'better-result';
import { ChromeNotFoundError } from './errors';
/**
 * Returns the path to a usable Chrome binary.
 *
 * Resolution order:
 *
 * 1. `explicitPath`, when given.
 * 2. The `BARLO_CHROME_PATH` environment variable.
 * 3. The `CHROME_PATH` environment variable.
 * 4. The standard install locations for the current platform, covering Chrome,
 *    Chrome Canary, Chromium, Edge, and Brave.
 * 5. Playwright's browser cache, newest Chromium build first. This is not a
 *    normal install location, but it makes barlo runnable in CI and on
 *    machines with no system browser.
 *
 * An explicit path or environment variable is used as given and never falls
 * back to the search — a wrong path is reported rather than silently ignored.
 *
 * @param explicitPath A Chrome binary to use instead of searching. Usually
 * {@linkcode LaunchOptions.executablePath} passed through by
 * {@linkcode launch}.
 * @returns The absolute path to a browser executable that exists on disk, or
 * {@linkcode ChromeNotFoundError} listing what was checked.
 *
 * @example Checking for a browser before launching
 * ```ts
 * import { findChrome } from "barlo";
 *
 * findChrome().match({
 *   ok: (path) => console.log(`Using ${path}`),
 *   err: (e) => console.error(e.message),
 * });
 * ```
 */
export declare function findChrome(explicitPath?: string): Result<string, ChromeNotFoundError>;
//# sourceMappingURL=find-chrome.d.ts.map