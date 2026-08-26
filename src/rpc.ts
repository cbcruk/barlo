/**
 * The Bun <-> page bridge behind app.exposeFunction().
 *
 * A CDP binding gives the page one synchronous channel out; every call is
 * tagged with a sequence number so replies can be routed back to the right
 * promise.
 */

export const BINDING = '__barlo_rpc__'
export const RESOLVER = '__barlo_resolve__'

export interface RpcCall {
  id: number
  name: string
  args: unknown[]
}

export const CHANNEL = '__barlo_call__'

/**
 * Build the bootstrap for a window's exposed functions.
 *
 * Safe to run more than once in the same document: the channel is installed
 * only on the first run, while the function bindings are always refreshed so
 * names exposed after load land without a reload.
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
  for (const name of ${JSON.stringify([...names])}) {
    globalThis[name] = (...args) => call(name, args);
  }
})();`
}

/** The reply expression evaluated in the page once a Bun-side call settles. */
export function resolverExpression(id: number, ok: boolean, value: unknown): string {
  const payload = ok ? value : String((value as Error)?.message ?? value)
  return `${RESOLVER}(${id}, ${ok}, ${JSON.stringify(payload ?? null)})`
}
