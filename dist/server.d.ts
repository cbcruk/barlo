/**
 * The application's HTTP origin, backing Carlo's serving API on `Bun.serve`.
 *
 * Routes are consulted longest-prefix first, and a handler that returns
 * `undefined` falls through to the next one, so a broad
 * {@linkcode AppServer.serveFolder} can sit behind a narrow
 * {@linkcode AppServer.serveHandler}. The server listens on `127.0.0.1` and
 * never on an external interface.
 *
 * @module
 */
/**
 * Reserved path serving a blank page, which Chrome opens at launch.
 *
 * Carlo's API registers routes *after* `launch()` returns, so the window needs
 * somewhere harmless to land in the meantime. Handled before user routes and
 * therefore not overridable.
 */
export declare const BLANK_PATH = "/__barlo/blank";
/**
 * A route handler.
 *
 * Return a `Response` to serve the request, or `undefined` to decline it and
 * let the next route try. Declining is how the fallthrough chain works — a
 * handler that returns a 404 `Response` ends the chain instead.
 */
export type RequestHandler = (request: Request) => Response | undefined | Promise<Response | undefined>;
/**
 * An in-memory file table, mapping a path to its contents.
 *
 * Keys are relative paths such as `"index.html"` or `"assets/app.js"`, with a
 * leading `./` or `/` tolerated. The content type is inferred from the key's
 * extension, defaulting to `application/octet-stream`.
 */
export type EmbeddedFiles = Record<string, string | Uint8Array | ArrayBuffer | Blob>;
/**
 * The HTTP server behind an {@linkcode App}.
 *
 * Register routes with the `serve*` methods, then {@linkcode AppServer.listen}
 * to bind a port. {@linkcode App} owns an instance and forwards to it, so
 * applications rarely construct one directly.
 */
export declare class AppServer {
    #private;
    /**
     * Serves files from a folder on disk.
     *
     * A request for a directory falls back to its `index.html`. Paths that
     * resolve outside the folder are declined rather than served, so `..`
     * traversal cannot escape.
     *
     * > This reads from disk at request time and therefore does **not** survive
     * > `bun build --compile`, where no folder sits beside the binary. Use
     * > {@linkcode AppServer.serveEmbedded} for compiled applications.
     *
     * @param folder Path to the folder, resolved against the working directory.
     * @param prefix URL prefix to mount it under.
     */
    serveFolder(folder: string, prefix?: string): void;
    /**
     * Reverse-proxies a prefix onto a remote origin.
     *
     * Useful for pointing a window at a running dev server so hot reload keeps
     * working. Upstream responses of 500 and above are treated as a failure and
     * fall through to the next route.
     *
     * @param base The origin to proxy to, such as `"http://localhost:5173"`.
     * @param prefix URL prefix to mount it under.
     *
     * @example Wrapping a Vite dev server
     * ```ts
     * import { launch } from "barlo";
     *
     * const app = await launch();
     *
     * app.serveOrigin("http://localhost:5173");
     * await app.load();
     * ```
     */
    serveOrigin(base: string, prefix?: string): void;
    /**
     * Serves an in-memory file table.
     *
     * The contents live in the bundle rather than on disk, which is what makes
     * this the serving method that survives `bun build --compile`.
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
     *
     * The cast is needed only because Bun types every `.html` import as an
     * `HTMLBundle` for its bundler.
     */
    serveEmbedded(files: EmbeddedFiles, prefix?: string): void;
    /**
     * Registers a handler for any request the other routes decline.
     *
     * Mounted at the root, so it sits behind every prefixed route.
     *
     * @param handler Called with the request; return `undefined` to decline.
     *
     * @example Adding a JSON endpoint
     * ```ts
     * import { launch } from "barlo";
     *
     * const app = await launch();
     *
     * app.serveHandler(request =>
     *   new URL(request.url).pathname === "/api/time"
     *     ? Response.json({ now: Date.now() })
     *     : undefined,
     * );
     * ```
     */
    serveHandler(handler: RequestHandler): void;
    /**
     * Binds an ephemeral port on `127.0.0.1` and starts serving.
     *
     * Idempotent: calling it again returns the origin already in use. Routes may
     * be registered before or after this call, since they are resolved per
     * request.
     *
     * @returns The origin now being served, such as `"http://127.0.0.1:53124"`.
     */
    listen(): string;
    /**
     * The origin currently being served.
     *
     * @throws When the server is not listening.
     */
    get origin(): string;
    /**
     * Stops the server and closes open connections.
     *
     * Registered routes are kept, so a later {@linkcode AppServer.listen} starts
     * serving them again on a new port. Idempotent.
     */
    stop(): void;
}
//# sourceMappingURL=server.d.ts.map