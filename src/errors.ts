/**
 * barlo's failure modes, as tagged errors.
 *
 * Every fallible operation returns a `Result` carrying one of these rather
 * than throwing, so a caller can tell "no browser installed" from "the browser
 * never came up" without reading message strings. Narrow with `_tag`, the
 * per-class `is` guard, or exhaustive `match`.
 *
 * @module
 */

import { TaggedError } from 'better-result'

/**
 * No Chrome, Chromium, Edge, or Brave could be found.
 *
 * Recoverable by installing one, or by pointing barlo at a binary through
 * {@linkcode LaunchOptions.executablePath} or `BARLO_CHROME_PATH`.
 */
export class ChromeNotFoundError extends TaggedError('ChromeNotFoundError')<{
  /** The paths that were checked, or the single path that was given and missing. */
  readonly searched: readonly string[]
  /** Human-readable summary, suitable for logging or showing the user. */
  readonly message: string
}> {}

/** The phase of startup that ran out of time. */
export type LaunchPhase = 'devtools-endpoint' | 'window'

/**
 * Chrome was started but did not become usable in time.
 *
 * `devtools-endpoint` means it never published a debugging endpoint — usually a
 * browser that failed to start at all, which `verbose: true` will show.
 * `window` means it started but opened no app window.
 */
export class LaunchTimeoutError extends TaggedError('LaunchTimeoutError')<{
  /** Which part of startup ran out of time. */
  readonly phase: LaunchPhase
  /** How long barlo waited, in milliseconds. */
  readonly ms: number
  /** Human-readable summary, suitable for logging or showing the user. */
  readonly message: string
}> {}

/**
 * The browser is gone: it exited, crashed, or the connection dropped.
 *
 * Everything on the {@linkcode App} fails this way once it happens, and the
 * app's exit handlers have already run.
 */
export class BrowserGoneError extends TaggedError('BrowserGoneError')<{
  /** Human-readable summary, suitable for logging or showing the user. */
  readonly message: string
}> {}

/** The operation needs a window, and the one it was given is closed. */
export class WindowClosedError extends TaggedError('WindowClosedError')<{
  /** Human-readable summary, suitable for logging or showing the user. */
  readonly message: string
}> {}

/** A navigation did not complete. */
export class NavigationError extends TaggedError('NavigationError')<{
  /** The URL that was being navigated to. */
  readonly url: string
  /** Human-readable summary, suitable for logging or showing the user. */
  readonly message: string
}> {}

/**
 * Code evaluated in the page threw.
 *
 * The message is the page-side one, so a `ReferenceError` in the page arrives
 * as a `ReferenceError` here.
 */
export class EvaluationError extends TaggedError('EvaluationError')<{
  /** The page-side error's message, including its own error type. */
  readonly message: string
}> {}

/**
 * Chrome rejected a DevTools Protocol command.
 *
 * Mostly reached through barlo's own wrappers, but also what a raw
 * {@linkcode Window.session} call surfaces.
 */
export class ProtocolError extends TaggedError('ProtocolError')<{
  /** The CDP method that failed, such as `"Page.navigate"`. */
  readonly method: string
  /** Chrome's own description of what it refused. */
  readonly message: string
}> {}

/**
 * Every failure barlo reports.
 *
 * Exhaustive `match` over this union is checked, so a new member becomes a
 * compile error at each call site rather than a surprise at runtime.
 */
export type BarloError =
  | ChromeNotFoundError
  | LaunchTimeoutError
  | BrowserGoneError
  | WindowClosedError
  | NavigationError
  | EvaluationError
  | ProtocolError

/**
 * What {@linkcode launch} can fail with.
 *
 * `ProtocolError` is in here because startup talks to Chrome before handing the
 * app over — a refused command during those first exchanges fails the launch.
 */
export type LaunchError =
  | ChromeNotFoundError
  | LaunchTimeoutError
  | BrowserGoneError
  | ProtocolError

/** What any operation on a window can fail with, before its own failures. */
export type WindowError = WindowClosedError | BrowserGoneError | ProtocolError

/** What {@linkcode Window.evaluate} can fail with. */
export type EvaluateError = WindowError | EvaluationError

/** What {@linkcode Window.load} can fail with. */
export type LoadError = WindowError | NavigationError
