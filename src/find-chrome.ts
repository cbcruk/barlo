/**
 * Locate a locally installed Chrome/Chromium.
 *
 * barlo never bundles a browser — that was Carlo's whole point, and it is
 * what keeps a compiled app in the tens of megabytes instead of hundreds.
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

export function findChrome(explicitPath?: string): string {
  const override = explicitPath ?? process.env['BARLO_CHROME_PATH'] ?? process.env['CHROME_PATH']
  if (override) {
    if (!existsSync(override)) throw new Error(`Chrome not found at ${override}`)
    return override
  }

  const candidates =
    process.platform === 'darwin'
      ? DARWIN
      : process.platform === 'win32'
        ? windowsCandidates()
        : LINUX

  const found = [...candidates, ...playwrightCandidates()].find(existsSync)
  if (found) return found

  throw new Error(
    'Could not find Chrome. Install Google Chrome, or point barlo at a binary ' +
      'with the BARLO_CHROME_PATH environment variable.',
  )
}
