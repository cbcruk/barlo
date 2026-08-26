/**
 * The Bun-to-page bridge behind {@linkcode App.exposeFunction}.
 *
 * A CDP binding gives the page one synchronous channel out; every call is
 * tagged with a sequence number so replies can be routed back to the right
 * promise. {@linkcode Window} owns the plumbing — nothing here is part of the
 * public API, and the three global names are implementation detail that pages
 * should not touch.
 *
 * @module
 */
/**
 * Name of the CDP binding installed with `Runtime.addBinding`.
 *
 * The page calls it with a JSON-encoded {@linkcode RpcCall}; Chrome forwards
 * that to Bun as a `Runtime.bindingCalled` event.
 */
export declare const BINDING = "__barlo_rpc__";
/**
 * Name of the page-side global that settles a pending call.
 *
 * Bun invokes it through `Runtime.evaluate` with the expression built by
 * {@linkcode resolverExpression}.
 */
export declare const RESOLVER = "__barlo_resolve__";
/**
 * Name of the page-side global holding the call dispatcher.
 *
 * Its presence marks a document as already bootstrapped, which is what makes
 * {@linkcode bootstrapSource} safe to run twice.
 */
export declare const CHANNEL = "__barlo_call__";
/** One call from the page to a function exposed on the Bun side. */
export interface RpcCall {
    /** Sequence number, unique per document, used to match the reply. */
    id: number;
    /** The exposed function's name, as given to {@linkcode App.exposeFunction}. */
    name: string;
    /** Arguments from the page, already round-tripped through JSON. */
    args: unknown[];
}
/**
 * Builds the page-side bootstrap that installs a window's exposed functions.
 *
 * The result is registered with `Page.addScriptToEvaluateOnNewDocument` so it
 * reaches future documents, and evaluated directly against the current one.
 *
 * Safe to run more than once in the same document: the channel is installed
 * only on the first run, while the function bindings are always refreshed, so
 * names exposed after load land without a reload.
 *
 * @param names The exposed function names to define as globals on the page.
 * @returns A self-invoking script, ready to hand to CDP.
 */
export declare function bootstrapSource(names: Iterable<string>): string;
/**
 * Builds the expression that settles a page-side call once Bun has an answer.
 *
 * Rejections travel as a message string rather than an `Error`, because only
 * JSON survives the CDP hop; the page reconstructs an `Error` from it.
 *
 * @param id The {@linkcode RpcCall.id} being answered.
 * @param ok `true` to resolve the page promise, `false` to reject it.
 * @param value The resolved value, or the rejection reason when `ok` is
 * `false`. A thrown `Error` is reduced to its message.
 * @returns An expression to run through `Runtime.evaluate`.
 */
export declare function resolverExpression(id: number, ok: boolean, value: unknown): string;
//# sourceMappingURL=rpc.d.ts.map