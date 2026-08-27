/**
 * A Chrome app-mode window and the operations available on it.
 *
 * @module
 */
import type { CDPSession } from './cdp';
/**
 * A window's position and size in screen pixels.
 *
 * Every field is optional: {@linkcode Window.setBounds} changes only the ones
 * given, leaving the rest as they are.
 */
export interface Bounds {
    /** Distance from the left edge of the screen. */
    left?: number;
    /** Distance from the top edge of the screen. */
    top?: number;
    /** Outer width, including the window frame. */
    width?: number;
    /** Outer height, including the window frame. */
    height?: number;
}
type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen';
/**
 * A Bun-side function callable from the page.
 *
 * Arguments arrive from the page as JSON, and the return value travels back
 * the same way, so it must be JSON-serializable. Returning a promise is
 * supported — the page waits for it. A thrown error rejects the page's promise
 * with an `Error` carrying the same message.
 */
export type ExposedFunction = (...args: any[]) => unknown;
/**
 * One Chrome app-mode window, driven over its own CDP session.
 *
 * Obtained from {@linkcode App.mainWindow}, {@linkcode App.windows}, or
 * {@linkcode App.createWindow} — never constructed directly, since a window
 * has to be adopted by an {@linkcode App} to receive the RPC bridge.
 */
export declare class Window {
    #private;
    /** The window's CDP target identifier, unique within the browser. */
    readonly targetId: string;
    /**
     * The CDP session scoped to this window's page.
     *
     * Exposed as an escape hatch for protocol calls barlo does not wrap, such as
     * `Emulation.setUserAgentOverride`.
     */
    readonly session: CDPSession;
    /**
     * Creates a window wrapper around an attached CDP session.
     *
     * @internal
     */
    constructor(session: CDPSession, browser: CDPSession, targetId: string, origin: string, exposed: Map<string, ExposedFunction>, title?: string);
    /**
     * Enables the CDP domains and installs the RPC bridge.
     *
     * @internal
     */
    _initialize(): Promise<void>;
    /**
     * Re-installs the RPC bridge so newly exposed names are callable.
     *
     * Applies to the current document as well as future ones, which is what lets
     * {@linkcode App.exposeFunction} take effect without a reload. Called by
     * {@linkcode App}; there is no need to call it directly.
     *
     * Does nothing once the window is closed.
     */
    syncBridge(): Promise<void>;
    /**
     * Navigates to a path relative to the application's origin.
     *
     * Resolves once the page's `load` event has fired, so the document is ready
     * for {@linkcode Window.evaluate} on return.
     *
     * @param uri A path such as `"index.html"`, relative to the origin. A
     * leading slash is tolerated. Defaults to the origin root.
     * @param params Query parameters to append.
     *
     * @example Passing state into the page
     * ```ts
     * import { launch } from "barlo";
     *
     * const app = await launch();
     *
     * app.serveFolder("./www");
     * await app.mainWindow().load("editor.html", { file: "notes.md" });
     * ```
     */
    load(uri?: string, params?: Record<string, string>): Promise<void>;
    /**
     * Lists exposed functions the loaded page has replaced with its own globals.
     *
     * A classic script's top-level `function` and `var` declarations become
     * properties of `window`, which is where {@linkcode App.exposeFunction}
     * installs its functions. A page declaring `function kill` therefore takes
     * over an exposed `kill`, and calls from the page reach the page itself
     * instead of Bun — silently, since the call still returns a promise.
     *
     * Wrap the page's script so it declares nothing globally, use
     * `<script type="module">`, or expose the function under a name the page does
     * not declare. barlo warns about this automatically after each load; this
     * method is for asserting on it in tests.
     *
     * @returns The shadowed names, empty when the bridge is intact.
     *
     * @example Guarding the bridge in a test
     * ```ts
     * import { launch } from "barlo";
     *
     * const app = await launch();
     *
     * await app.load("index.html");
     * console.assert((await app.mainWindow().shadowedFunctions()).length === 0);
     * ```
     */
    shadowedFunctions(): Promise<string[]>;
    /**
     * Runs code in the page and returns its result.
     *
     * A function is serialized and called with the given arguments, which means
     * it runs in the page and cannot close over anything in Bun. A string is
     * evaluated as an expression. Promises are awaited before the value is
     * returned.
     *
     * The result travels as JSON, so DOM nodes and functions do not survive the
     * trip.
     *
     * @template T The expected result type. Not checked at runtime.
     * @param script A function to call in the page, or an expression to evaluate.
     * @param args Arguments for `script` when it is a function. Serialized to
     * JSON, so they must not contain functions or cycles.
     * @returns The value the code produced.
     * @throws When the code throws in the page, carrying the page-side message.
     *
     * @example Reading from the DOM
     * ```ts
     * import { launch } from "barlo";
   *
   * const app = await launch();
   *
     * const title = await app.evaluate<string>("document.title");
     * ```
     *
     * @example Calling a function with arguments
     * ```ts
     * import { launch } from "barlo";
   *
   * const app = await launch();
   *
     * const sum = await app.evaluate((a: number, b: number) => a + b, 2, 3);
     * ```
     */
    evaluate<T = unknown>(script: string | ((...args: any[]) => T), ...args: unknown[]): Promise<T>;
    /**
     * Captures the window's viewport as an image.
     *
     * @param options Encoding settings.
     * @param options.format Image format. Defaults to `"png"`.
     * @param options.quality Compression quality from 0 to 100. Ignored for
     * `"png"`.
     * @returns The encoded image bytes.
     *
     * @example Saving a screenshot
     * ```ts
     * import { launch } from "barlo";
   *
   * const app = await launch();
   *
     * await Bun.write("shot.png", await app.screenshot());
     * ```
     */
    screenshot(options?: {
        format?: 'png' | 'jpeg' | 'webp';
        quality?: number;
    }): Promise<Uint8Array>;
    /**
     * Reads the window's current position, size, and state.
     *
     * @returns The bounds, with every field populated, plus the window state.
     */
    bounds(): Promise<Required<Bounds> & {
        windowState: WindowState;
    }>;
    /**
     * Moves or resizes the window.
     *
     * Omitted fields are left unchanged. Has no visible effect while the window
     * is maximized or fullscreen.
     *
     * Height does not round-trip on macOS: a window set to 700 comes back as 677,
     * short by the title bar, from both {@linkcode Window.bounds} and the page's
     * `window.outerHeight`. Add the title bar yourself if an exact height
     * matters there. Width is exact everywhere, as is height on Linux and
     * Windows.
     *
     * @param bounds The position and size fields to change.
     *
     * @example Centring a window
     * ```ts
     * import { launch } from "barlo";
   *
   * const app = await launch();
   *
     * await app.mainWindow().setBounds({ left: 200, top: 120, width: 900, height: 700 });
     * ```
     */
    setBounds(bounds: Bounds): Promise<void>;
    /** Puts the window into fullscreen. */
    fullscreen: () => Promise<void>;
    /** Maximizes the window. */
    maximize: () => Promise<void>;
    /** Minimizes the window. */
    minimize: () => Promise<void>;
    /** Raises the window above other windows and focuses it. */
    bringToFront(): Promise<void>;
    /**
     * Registers a handler for the window closing.
     *
     * Fires whether the user closed the window, {@linkcode Window.close} did, or
     * Chrome exited.
     *
     * @param handler Called once, when the window closes.
     * @returns A function that removes the handler.
     */
    onClose(handler: () => void): () => void;
    /** Whether the window has closed. Operations on a closed window fail. */
    get closed(): boolean;
    /**
     * Marks the window closed and runs its close handlers.
     *
     * @internal
     */
    _markClosed(): void;
    /**
     * Closes the window when a `using` block ends.
     *
     * Equivalent to {@linkcode Window.close}. Closing the application's last
     * window exits it, so a scoped window is a scoped application when it is the
     * only one.
     *
     * @example A secondary window that cannot outlive its block
     * ```ts
     * import { launch } from "barlo";
     *
     * const app = await launch();
     *
     * {
     *   await using preferences = await app.createWindow("preferences.html");
     *
     *   await preferences.evaluate("document.title");
     * }
     * ```
     */
    [Symbol.asyncDispose](): Promise<void>;
    /**
     * Closes the window.
     *
     * Idempotent. Closing the last window of an {@linkcode App} exits the
     * application.
     */
    close(): Promise<void>;
}
export {};
//# sourceMappingURL=window.d.ts.map