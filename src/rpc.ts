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

import { Result } from 'better-result'

/**
 * Name of the CDP binding installed with `Runtime.addBinding`.
 *
 * The page calls it with a JSON-encoded {@linkcode RpcCall}; Chrome forwards
 * that to Bun as a `Runtime.bindingCalled` event.
 */
export const BINDING = '__barlo_rpc__'

/**
 * Name of the page-side global that settles a pending call.
 *
 * Bun invokes it through `Runtime.evaluate` with the expression built by
 * {@linkcode resolverExpression}.
 */
export const RESOLVER = '__barlo_resolve__'

/**
 * Name of the page-side global holding the call dispatcher.
 *
 * Its presence marks a document as already bootstrapped, which is what makes
 * {@linkcode bootstrapSource} safe to run twice.
 */
export const CHANNEL = '__barlo_call__'

/**
 * Name of the page-side global recording which function each exposed name was
 * installed as.
 *
 * Only used to notice that a page has since replaced one. See
 * {@linkcode shadowedExpression}.
 */
export const REGISTRY = '__barlo_installed__'

/** One call from the page to a function exposed on the Bun side. */
export interface RpcCall {
  /** Sequence number, unique per document, used to match the reply. */
  id: number
  /** The exposed function's name, as given to {@linkcode App.exposeFunction}. */
  name: string
  /** Arguments from the page, already round-tripped through JSON. */
  args: unknown[]
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
export function bootstrapSource(names: Iterable<string>): string {
  return `(() => {
  let call = globalThis.${CHANNEL};
  if (!call) {
    const pending = new Map();
    let seq = 0;
    Object.defineProperty(globalThis, ${JSON.stringify(RESOLVER)}, {
      value: (id, ok, value) => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        ok ? entry.resolve(value) : entry.reject(new Error(value));
      },
    });
    call = (name, args) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      globalThis.${BINDING}(JSON.stringify({ id, name, args }));
    });
    Object.defineProperty(globalThis, ${JSON.stringify(CHANNEL)}, { value: call });
  }
  if (!globalThis.${REGISTRY}) {
    Object.defineProperty(globalThis, ${JSON.stringify(REGISTRY)}, { value: {} });
  }
  const registry = globalThis.${REGISTRY};
  for (const name of ${JSON.stringify([...names])}) {
    const fn = (...args) => call(name, args);
    registry[name] = fn;
    globalThis[name] = fn;
  }
})();`
}

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
export function resolverExpression(id: number, ok: boolean, value: unknown): string {
  const payload = ok ? value : String((value as Error)?.message ?? value)

  // A value that will not serialize — anything cyclic, most obviously — used to
  // throw here, leaving the page's promise unsettled forever. Rejecting it with
  // the reason is the one outcome that is never a hang.
  const encoded = Result.try({
    try: () => JSON.stringify(payload ?? null),
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  })
  if (encoded.isErr()) {
    const reason = `barlo could not send the result back: ${encoded.error}`
    return `${RESOLVER}(${id}, false, ${JSON.stringify(reason)})`
  }
  return `${RESOLVER}(${id}, ${ok}, ${encoded.unwrap()})`
}

/**
 * Builds the expression listing exposed names the page has since replaced.
 *
 * A classic script's top-level `function` and `var` declarations become
 * properties of `window`, which is where the bridge installs its functions, so
 * a page declaring `function kill` silently takes over an exposed `kill` and
 * calls itself instead. Comparing each global against what was installed is
 * the only way to notice: locking the property down is not an option, since a
 * non-configurable global makes the page's own declaration throw and kills the
 * script outright.
 *
 * @returns An expression evaluating to an array of shadowed names.
 */
export function shadowedExpression(): string {
  return `Object.keys(globalThis.${REGISTRY} ?? {}).filter(
    n => globalThis[n] !== globalThis.${REGISTRY}[n],
  )`
}
