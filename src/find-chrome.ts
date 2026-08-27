/**
 * Locates a locally installed Chrome, Chromium, Edge, or Brave.
 *
 * barlo never bundles a browser — that was Carlo's whole point, and it is what
 * keeps a compiled app in the tens of megabytes instead of hundreds.
 *
 * @module
 */

import { Result } from 'better-result'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ChromeNotFoundError } from './errors'

const DARWIN = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
]

const LINUX = [
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/microsoft-edge',
  '/usr/bin/brave-browser',
  '/snap/bin/chromium',
]

function windowsCandidates(): string[] {
  const roots = [
    process.env['PROGRAMFILES'],
    process.env['PROGRAMFILES(X86)'],
    process.env['LOCALAPPDATA'],
  ].filter((root): root is string => Boolean(root))

  const suffixes = [
    join('Google', 'Chrome', 'Application', 'chrome.exe'),
    join('Google', 'Chrome SxS', 'Application', 'chrome.exe'),
    join('Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ]

  return roots.flatMap(root => suffixes.map(suffix => join(root, suffix)))
}

/**
 * Playwright's browser cache. Not a normal install location, but it makes
 * barlo runnable in CI and on headless boxes without a system Chrome.
 */
function playwrightCandidates(): string[] {
  const cache =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
      : process.platform === 'win32'
        ? join(process.env['LOCALAPPDATA'] ?? '', 'ms-playwright')
        : join(homedir(), '.cache', 'ms-playwright')

  if (!existsSync(cache)) return []

  const binary =
    process.platform === 'darwin'
      ? join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
      : process.platform === 'win32'
        ? join('chrome-win', 'chrome.exe')
        : join('chrome-linux', 'chrome')

  return readdirSync(cache)
    .filter(entry => entry.startsWith('chromium-'))
    .sort()
    .reverse()
    .map(entry => join(cache, entry, binary))
}

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
export function findChrome(explicitPath?: string): Result<string, ChromeNotFoundError> {
  const override = explicitPath ?? process.env['BARLO_CHROME_PATH'] ?? process.env['CHROME_PATH']
  if (override) {
    return existsSync(override)
      ? Result.ok(override)
      : Result.err(
          new ChromeNotFoundError({
            searched: [override],
            message: `Chrome not found at ${override}`,
          }),
        )
  }

  const candidates =
    process.platform === 'darwin'
      ? DARWIN
      : process.platform === 'win32'
        ? windowsCandidates()
        : LINUX

  const searched = [...candidates, ...playwrightCandidates()]
  const found = searched.find(existsSync)
  if (found) return Result.ok(found)

  return Result.err(
    new ChromeNotFoundError({
      searched,
      message:
        'Could not find Chrome. Install Google Chrome, or point barlo at a binary ' +
        'with the BARLO_CHROME_PATH environment variable.',
    }),
  )
}
