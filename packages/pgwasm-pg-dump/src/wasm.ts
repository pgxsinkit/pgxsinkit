// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

/**
 * pg_dump's WebAssembly module, fetched and compiled once per URL. One path for Bun and browsers: Bun's
 * `fetch` reads `file://` URLs and serves `.wasm` as `application/wasm`.
 */

const compiled = new Map<string, Promise<WebAssembly.Module>>();

export function compileModule(url: URL): Promise<WebAssembly.Module> {
  const key = url.href;
  let pending = compiled.get(key);
  if (pending === undefined) {
    pending = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not load ${key}: HTTP ${response.status} ${response.statusText}`);
      try {
        // Bun's Response and the WebAssembly typings' Response are distinct declarations of one type.
        return await WebAssembly.compileStreaming(
          response.clone() as unknown as Parameters<typeof WebAssembly.compileStreaming>[0],
        );
      } catch (error) {
        // A server that sends the wrong MIME type defeats streaming compilation; compile the bytes.
        if (error instanceof TypeError) return await WebAssembly.compile(await response.arrayBuffer());
        throw error;
      }
    })();
    compiled.set(key, pending);
    // A failed download or compile is retried on the next dump rather than cached.
    pending.catch(() => compiled.delete(key));
  }
  return pending;
}
