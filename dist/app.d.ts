/**
 * The barlo application: a Bun-served origin plus one or more Chrome app
 * windows.
 *
 * @module
 */
import { type EmbeddedFiles, type RequestHandler } from './server';
import { Window, type ExposedFunction } from './window';
/** Settings for {@linkcode launch}. */
export interface LaunchOptions {
    /**
     * Window title, re-applied after every navigation so it wins over the
     * document's own `<title>`. Defaults to letting the document decide.
     */
    title?: string;
    /** Initial outer window width in pixels. Defaults to `800`. */
    width?: number;
    /** Initial outer window height in pixels. Defaults to `600`. */
    height?: number;
    /**
     * Initial distance from the left edge of the screen, in pixels. Applied only
     * when {@linkcode LaunchOptions.top} is given as well; otherwise Chrome
     * places the window.
     */
    left?: number;
    /**
     * Initial distance from the top edge of the screen, in pixels. Applied only
     * when {@linkcode LaunchOptions.left} is given as well.
     */
    top?: number;
    /**
     * Path to a Chrome, Chromium, Edge, or Brave binary, skipping the search
     * described in {@linkcode findChrome}.
     */
    executablePath?: string;
    /**
     * Extra Chrome switches, appended after barlo's own. Chrome resolves
     * duplicate switches last-wins, so these override the defaults.
     *
     * Note that `--headless` cannot be undone this way: Chrome decides from the
     * switch's presence, not its value.
     */
    args?: string[];
    /**
     * Profile directory, holding cookies, localStorage, and the DevTools
     * endpoint file.
     *
     * A temporary directory is created and deleted on exit when omitted. Pass a
     * stable path to persist state between runs.
     */
    userDataDir?: string;
    /**
     * Forward Chrome's stderr to Bun's. Defaults to `false`.
     *
     * Chrome is noisy even when healthy, but this is where a startup crash
     * reports itself.
     */
    verbose?: boolean;
    /**
     * Milliseconds to wait for Chrome to start and open its window. Defaults to
     * `20000`.
     */
    timeout?: number;
}
/**
 * A running barlo application: an HTTP origin, a Chrome process, and its
 * windows.
 *
 * Created by {@linkcode launch}, which is the only supported way to get one —
 * the constructor does not start anything.
 *
 * Serving routes and exposed functions are registered on the app and shared by
 * every window it opens.
 */
export declare class App {
    #private;
    /**
     * Stores the launch settings. Nothing is started until `_start` runs.
     *
     * @internal
     */
    constructor(options: LaunchOptions);
    /**
     * Serves files from a folder on disk. See {@linkcode AppServer.serveFolder}.
     *
     * > Does not survive `bun build --compile`; use
     * > {@linkcode App.serveEmbedded} for compiled applications.
     *
     * @param folder Path to the folder, resolved against the working directory.
     * @param prefix URL prefix to mount it under.
     */
    serveFolder(folder: string, prefix?: string): void;
    /**
     * Reverse-proxies a prefix onto a remote origin, such as a dev server. See
     * {@linkcode AppServer.serveOrigin}.
     *
     * @param base The origin to proxy to.
     * @param prefix URL prefix to mount it under.
     */
    serveOrigin(base: string, prefix?: string): void;
    /**
     * Serves an in-memory map of path to contents. See
     * {@linkcode AppServer.serveEmbedded}.
     *
     * Unlike {@linkcode App.serveFolder}, the contents live in the bundle rather
     * than on disk, so this is the serving method that survives
     * `bun build --compile`.
     *
     * @param files The paths to serve and their contents.
     * @param prefix URL prefix to mount them under.
     *
     * @example Embedding a page into a compiled binary
     * ```ts
     * import { launch } from "barlo";
     * import index from "./www/index.html" with { type: "text" };
     *
     * const app = await launch();
     *
     * app.serveEmbedded({ "index.html": index as unknown as string });
     * await app.load("index.html");
     * ```
     */
    serveEmbedded(files: EmbeddedFiles, prefix?: string): void;
    /**
     * Registers a fallthrough request handler. See
     * {@linkcode AppServer.serveHandler}.
     *
     * @param handler Called with the request; return `undefined` to decline.
     */
    serveHandler(handler: RequestHandler): void;
    /**
     * Makes a Bun-side function callable from the page as `window[name]`.
     *
     * The page-side function always returns a promise, whatever `fn` returns.
     * Arguments and results round-trip as JSON, and a thrown error rejects the
     * page's promise with the same message.
     *
     * Takes effect immediately in every open window, including their current
     * documents, so there is no need to reload or to expose everything before
     * the first {@linkcode App.load}. Windows opened later inherit it. Exposing
     * the same name twice replaces the earlier function.
     *
     * > The page can take the name back. A classic script's top-level `function`
     * > and `var` declarations become properties of `window`, so a page
     * > containing `function kill` replaces an exposed `kill` and its own calls
     * > reach itself instead of Bun — silently, since the call still returns a
     * > promise. Wrap the page's script so it declares nothing globally, use
     * > `<script type="module">`, or expose under a name the page does not
     * > declare, such as `__kill`. barlo warns after each load, and
     * > {@linkcode Window.shadowedFunctions} reports it for tests.
     *
     * @param name The global to define on the page. Overwrites an existing
     * global of that name, and can in turn be overwritten by one the page
     * declares.
     * @param fn The function to run in Bun. May be async.
     *
     * @example Reading a file for the page
     * ```ts
     * import { launch } from "barlo";
     *
     * const app = await launch();
     *
     * await app.exposeFunction("readFile", (path: string) => Bun.file(path).text());
     * ```
     *
     * The page calls `await window.readFile("notes.md")`.
     */
    exposeFunction(name: string, fn: ExposedFunction): Promise<void>;
    /**
     * Starts Chrome and opens the first window, cleaning up on failure.
     *
     * @internal
     */
    _start(): Promise<void>;
    /**
     * Opens another app window on the same origin.
     *
     * Re-running the Chrome binary against the same profile hands the request to
     * the running browser process, which is how Carlo did it too — CDP has no
     * app-mode window type. The new window inherits every exposed function.
     *
     * @param uri A path relative to the origin for the new window to open.
     * Defaults to the origin root.
     * @returns The new window, already navigated and bridged.
     * @throws When the app is not running, or when no new window appears within
     * {@linkcode LaunchOptions.timeout} milliseconds.
     *
     * @example Opening a second window
     * ```ts
     * import { launch } from "barlo";
   *
   * const app = await launch();
   *
     * const preferences = await app.createWindow("preferences.html");
     *
     * await preferences.setBounds({ width: 480, height: 320 });
     * ```
     */
    createWindow(uri?: string): Promise<Window>;
    /**
     * The application's first still-open window.
     *
     * {@linkcode App.load}, {@linkcode App.evaluate}, and
     * {@linkcode App.screenshot} are shorthands for calling the same method on
     * it.
     *
     * @returns The oldest open window.
     * @throws When every window has closed.
     */
    mainWindow(): Window;
    /**
     * Every open window, oldest first.
     *
     * @returns A new array; closed windows are omitted.
     */
    windows(): Window[];
    /**
     * Navigates the main window. See {@linkcode Window.load}.
     *
     * @param uri A path relative to the origin. Defaults to the origin root.
     * @param params Query parameters to append.
     */
    load(uri?: string, params?: Record<string, string>): Promise<void>;
    /**
     * Captures the main window's viewport. See {@linkcode Window.screenshot}.
     *
     * @param options Encoding settings.
     * @returns The encoded image bytes.
     */
    screenshot(options?: {
        format?: 'png' | 'jpeg' | 'webp';
        quality?: number;
    }): Promise<Uint8Array>;
    /**
     * Runs code in the main window. See {@linkcode Window.evaluate}.
     *
     * @template T The expected result type.
     * @param script A function to call in the page, or an expression to evaluate.
     * @param args Arguments for `script` when it is a function.
     * @returns The value the code produced.
     */
    evaluate<T = unknown>(script: string | ((...args: any[]) => T), ...args: unknown[]): Promise<T>;
    /**
     * Registers a handler for the application exiting.
     *
     * Fires when the last window closes, when Chrome quits, and when
     * {@linkcode App.exit} is called. barlo does not stop the Bun process
     * itself, so this is where an application usually calls `process.exit`.
     *
     * @param handler Called once, when the application exits.
     * @returns A function that removes the handler.
     *
     * @example Quitting with the window
     * ```ts
     * import { launch } from "barlo";
   *
   * const app = await launch();
   *
     * app.onExit(() => process.exit(0));
     * ```
     */
    onExit(handler: () => void): () => void;
    /** Whether the application has exited. */
    get exited(): boolean;
    /**
     * Shuts the application down when a `using` block ends.
     *
     * Equivalent to {@linkcode App.exit}, so the window, Chrome, the server, and
     * the profile directory are all released without a `try`/`finally`.
     *
     * @example Tying the app to a scope
     * ```ts
     * import { launch } from "barlo";
     *
     * {
     *   await using app = await launch();
     *
     *   app.serveFolder("./www");
     *   await app.load("index.html");
     *   await app.evaluate("document.title");
     * }
     * // Chrome is gone here, even if the block threw.
     * ```
     */
    [Symbol.asyncDispose](): Promise<void>;
    /**
     * Shuts the application down.
     *
     * Closes the CDP connection, stops the HTTP server, kills Chrome, and
     * removes the profile directory if barlo created it. Idempotent, and safe to
     * call from an {@linkcode App.onExit} handler.
     */
    exit(): void;
}
//# sourceMappingURL=app.d.ts.map