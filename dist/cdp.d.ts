/**
 * Minimal Chrome DevTools Protocol client over a WebSocket.
 *
 * Carlo leaned on Puppeteer for this; Bun ships a WebSocket client, so the
 * whole transport is a few dozen lines and barlo stays dependency-free.
 *
 * Sessions are flattened: one socket carries the browser-level connection and
 * every attached target, distinguished by `sessionId`. This module is internal
 * plumbing for {@linkcode App} and {@linkcode Window}.
 *
 * @module
 */
import { Result } from 'better-result';
import { BrowserGoneError, ProtocolError } from './errors';
/** What a CDP command can fail with. */
export type SendError = ProtocolError | BrowserGoneError;
type Handler = (params: any) => void;
/**
 * A CDP command and event scope: either the browser itself or one attached
 * target.
 *
 * Commands sent through a session are answered by whatever it is scoped to, so
 * page-domain commands need a target session while browser-domain commands
 * such as `Browser.setWindowBounds` need {@linkcode CDPConnection.browser}.
 */
export declare class CDPSession {
    #private;
    /**
     * The session's CDP identifier, or `undefined` for the browser-level
     * session, whose messages carry no `sessionId`.
     */
    readonly sessionId: string | undefined;
    /**
     * Creates a session. Called by {@linkcode CDPConnection}; not useful
     * directly, since a session must be registered with its connection to
     * receive events.
     *
     * @param connection The connection carrying this session's messages.
     * @param sessionId The attached target's identifier, omitted for the
     * browser-level session.
     */
    constructor(connection: CDPConnection, sessionId?: string);
    /**
     * Sends a CDP command and resolves with its result.
     *
     * @template T The shape of the command's result object.
     * @param method A domain-qualified method name, such as `"Page.navigate"`.
     * @param params The command's parameters. Must be JSON-serializable.
     * @returns The command's `result` object, {@linkcode ProtocolError} when
     * Chrome refuses it, or {@linkcode BrowserGoneError} when the connection
     * closes while it is in flight.
     *
     * @example Reading the page title
     * ```ts
     * import { launch } from "barlo";
     *
     * const app = (await launch()).unwrap();
     *
     * const session = app.mainWindow().unwrap().session;
     *
     * const sent = await session.send("Runtime.evaluate", {
     *   expression: "document.title",
     *   returnByValue: true,
     * });
     * const title = sent.map((r) => r.result.value).unwrapOr("");
     * ```
     */
    send<T = any>(method: string, params?: Record<string, unknown>): Promise<Result<T, SendError>>;
    /**
     * Subscribes to a CDP event on this session.
     *
     * @param event A domain-qualified event name, such as
     * `"Runtime.bindingCalled"`.
     * @param handler Called with the event's parameters.
     * @returns A function that removes the subscription.
     */
    on(event: string, handler: Handler): () => void;
    /** @internal */
    _emit(event: string, params: any): void;
    /**
     * Attaches to a target and returns a session scoped to it.
     *
     * Only meaningful on the browser-level session. Attaching twice to the same
     * target returns the same {@linkcode CDPSession}.
     *
     * @param targetId The target to attach to, from `Target.getTargets`.
     * @returns A session whose commands and events belong to that target, or why
     * the attach failed.
     */
    attach(targetId: string): Promise<Result<CDPSession, SendError>>;
}
/**
 * A live WebSocket connection to Chrome's DevTools endpoint.
 *
 * Owns the socket, the request/response correlation, and the session table.
 * When the socket closes, every in-flight command comes back as
 * {@linkcode BrowserGoneError} and `"__disconnected__"` is emitted on
 * {@linkcode CDPConnection.browser}, which is how {@linkcode App} learns that
 * Chrome went away.
 */
export declare class CDPConnection {
    #private;
    /**
     * The browser-level session, for `Browser.*` and `Target.*` commands and for
     * the synthetic `"__disconnected__"` event.
     */
    readonly browser: CDPSession;
    private constructor();
    /**
     * Opens a connection to a DevTools WebSocket endpoint.
     *
     * The endpoint URL comes from the `DevToolsActivePort` file Chrome writes
     * into its profile directory.
     *
     * @param url A `ws://` DevTools browser endpoint.
     * @param signal Aborts the attempt while the socket is still opening.
     * @returns A connection whose socket is open and ready for commands, or why
     * the handshake did not complete.
     */
    static connect(url: string, signal?: AbortSignal): Promise<Result<CDPConnection, BrowserGoneError>>;
    /** @internal */
    _register(sessionId: string): CDPSession;
    /** @internal */
    _send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<Result<any, SendError>>;
    /** Whether the socket has closed, by request or because Chrome exited. */
    get closed(): boolean;
    /**
     * Closes the socket.
     *
     * Idempotent. In-flight commands are settled as
     * {@linkcode BrowserGoneError} by the socket's close handler.
     */
    close(): void;
}
export {};
//# sourceMappingURL=cdp.d.ts.map