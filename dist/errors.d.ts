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
declare const ChromeNotFoundError_base: import("better-result").TaggedErrorClass<"ChromeNotFoundError">;
/**
 * No Chrome, Chromium, Edge, or Brave could be found.
 *
 * Recoverable by installing one, or by pointing barlo at a binary through
 * {@linkcode LaunchOptions.executablePath} or `BARLO_CHROME_PATH`.
 */
export declare class ChromeNotFoundError extends ChromeNotFoundError_base<{
    /** The paths that were checked, or the single path that was given and missing. */
    readonly searched: readonly string[];
    /** Human-readable summary, suitable for logging or showing the user. */
    readonly message: string;
}> {
}
/** The phase of startup that ran out of time. */
export type LaunchPhase = 'devtools-endpoint' | 'window';
declare const LaunchTimeoutError_base: import("better-result").TaggedErrorClass<"LaunchTimeoutError">;
/**
 * Chrome was started but did not become usable in time.
 *
 * `devtools-endpoint` means it never published a debugging endpoint — usually a
 * browser that failed to start at all, which `verbose: true` will show.
 * `window` means it started but opened no app window.
 */
export declare class LaunchTimeoutError extends LaunchTimeoutError_base<{
    /** Which part of startup ran out of time. */
    readonly phase: LaunchPhase;
    /** How long barlo waited, in milliseconds. */
    readonly ms: number;
    /** Human-readable summary, suitable for logging or showing the user. */
    readonly message: string;
}> {
}
declare const BrowserGoneError_base: import("better-result").TaggedErrorClass<"BrowserGoneError">;
/**
 * The browser is gone: it exited, crashed, or the connection dropped.
 *
 * Everything on the {@linkcode App} fails this way once it happens, and the
 * app's exit handlers have already run.
 */
export declare class BrowserGoneError extends BrowserGoneError_base<{
    /** Human-readable summary, suitable for logging or showing the user. */
    readonly message: string;
}> {
}
declare const WindowClosedError_base: import("better-result").TaggedErrorClass<"WindowClosedError">;
/** The operation needs a window, and the one it was given is closed. */
export declare class WindowClosedError extends WindowClosedError_base<{
    /** Human-readable summary, suitable for logging or showing the user. */
    readonly message: string;
}> {
}
declare const NavigationError_base: import("better-result").TaggedErrorClass<"NavigationError">;
/** A navigation did not complete. */
export declare class NavigationError extends NavigationError_base<{
    /** The URL that was being navigated to. */
    readonly url: string;
    /** Human-readable summary, suitable for logging or showing the user. */
    readonly message: string;
}> {
}
declare const EvaluationError_base: import("better-result").TaggedErrorClass<"EvaluationError">;
/**
 * Code evaluated in the page threw.
 *
 * The message is the page-side one, so a `ReferenceError` in the page arrives
 * as a `ReferenceError` here.
 */
export declare class EvaluationError extends EvaluationError_base<{
    /** The page-side error's message, including its own error type. */
    readonly message: string;
}> {
}
declare const ProtocolError_base: import("better-result").TaggedErrorClass<"ProtocolError">;
/**
 * Chrome rejected a DevTools Protocol command.
 *
 * Mostly reached through barlo's own wrappers, but also what a raw
 * {@linkcode Window.session} call surfaces.
 */
export declare class ProtocolError extends ProtocolError_base<{
    /** The CDP method that failed, such as `"Page.navigate"`. */
    readonly method: string;
    /** Chrome's own description of what it refused. */
    readonly message: string;
}> {
}
/**
 * Every failure barlo reports.
 *
 * Exhaustive `match` over this union is checked, so a new member becomes a
 * compile error at each call site rather than a surprise at runtime.
 */
export type BarloError = ChromeNotFoundError | LaunchTimeoutError | BrowserGoneError | WindowClosedError | NavigationError | EvaluationError | ProtocolError;
/**
 * What {@linkcode launch} can fail with.
 *
 * `ProtocolError` is in here because startup talks to Chrome before handing the
 * app over — a refused command during those first exchanges fails the launch.
 */
export type LaunchError = ChromeNotFoundError | LaunchTimeoutError | BrowserGoneError | ProtocolError;
/** What any operation on a window can fail with, before its own failures. */
export type WindowError = WindowClosedError | BrowserGoneError | ProtocolError;
/** What {@linkcode Window.evaluate} can fail with. */
export type EvaluateError = WindowError | EvaluationError;
/** What {@linkcode Window.load} can fail with. */
export type LoadError = WindowError | NavigationError;
export {};
//# sourceMappingURL=errors.d.ts.map