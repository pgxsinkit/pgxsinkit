// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

/**
 * Fetching and compiling the artefacts. One path for Bun and browsers: Bun's `fetch` reads `file://`
 * URLs and serves `.wasm` as `application/wasm`, so neither needs a Node `fs` branch.
 */

const downloads = new Map<string, Promise<Response>>();
const compiled = new Map<string, Promise<WebAssembly.Module>>();
const bundles = new Map<string, Promise<ArrayBuffer>>();

function download(url: URL): Promise<Response> {
  const key = url.href;
  let pending = downloads.get(key);
  if (pending === undefined) {
    pending = fetch(url).then((response) => {
      if (!response.ok) {
        throw new Error(`Could not load ${key}: HTTP ${response.status} ${response.statusText}`);
      }
      return response;
    });
    downloads.set(key, pending);
    // A failed download is retried on the next boot rather than cached.
    pending.catch(() => downloads.delete(key));
  }
  return pending;
}

/** Start downloading an artefact now, so it is on its way when the boot needs it. */
export function prefetch(url: URL): void {
  download(url).catch(() => undefined);
}

/** The compiled module at `url`, compiled once per URL. */
export function compileModule(url: URL): Promise<WebAssembly.Module> {
  const key = url.href;
  let pending = compiled.get(key);
  if (pending === undefined) {
    pending = download(url).then(async (response) => {
      try {
        // Bun's Response and the WebAssembly typings' Response are distinct declarations of one type.
        return await WebAssembly.compileStreaming(
          response.clone() as unknown as Parameters<typeof WebAssembly.compileStreaming>[0],
        );
      } catch (error) {
        // A server that sends the wrong MIME type defeats streaming compilation; compile the bytes.
        if (error instanceof TypeError) return await WebAssembly.compile(await response.clone().arrayBuffer());
        throw error;
      }
    });
    compiled.set(key, pending);
    pending.catch(() => compiled.delete(key));
  }
  return pending;
}

/** The filesystem bundle's bytes, fetched once per URL; every caller gets its own copy. */
export async function loadBundle(url: URL): Promise<ArrayBuffer> {
  const key = url.href;
  let pending = bundles.get(key);
  if (pending === undefined) {
    pending = download(url).then((response) => response.clone().arrayBuffer());
    bundles.set(key, pending);
    pending.catch(() => bundles.delete(key));
  }
  // A module may keep views into the buffer it was given and write through them, so no two modules
  // share one.
  return (await pending).slice(0);
}

/** A Blob or its promise, as bytes. */
export async function bytesOf(source: Blob | Promise<Blob>): Promise<ArrayBuffer> {
  return await (await source).arrayBuffer();
}
