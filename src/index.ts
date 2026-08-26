/**
 * barlo — build desktop apps with Bun and the Chrome you already have.
 *
 * A port of GoogleChromeLabs/carlo. Same idea: serve your web app from the
 * runtime, open it in a chrome-less Chrome window, and let the page call back
 * into system-capable code.
 */

import { App, type LaunchOptions } from './app'

export { App, type LaunchOptions } from './app'
export { Window, type Bounds, type ExposedFunction } from './window'
export { type EmbeddedFiles, type RequestHandler } from './server'
export { findChrome } from './find-chrome'

export async function launch(options: LaunchOptions = {}): Promise<App> {
  const app = new App(options)
  await app._start()
  return app
}

export default { launch }
