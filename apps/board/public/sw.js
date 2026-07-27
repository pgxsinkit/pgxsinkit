// The board's offline-return service worker (board ADR-0010). Plain, un-bundled JavaScript by
// necessity: Vite copies `public/` verbatim to the build root, so this file gets no imports, no
// transform and no `import.meta.env` substitution — everything it needs it derives at runtime from
// `self.registration.scope`. That is also what lets ONE file serve both surfaces: registered against
// `import.meta.env.BASE_URL`, its scope is `/` under local preview and `/demo/` on GitHub Pages.
//
// Fetch policy, two branches:
//   • navigations → network-first with cache fallback. Fresh deploys therefore win on every online
//     navigation, which is why there is no update prompt: an online visit can never be served a stale
//     shell.
//   • every other same-origin GET → cache-first with background fill. The app bundle, the PGlite
//     wasm/data blobs and the worker scripts are captured AS THE APP FETCHES THEM ANYWAY, so a visitor
//     who bounces off the login screen downloads nothing extra.
//
// Cross-origin traffic (Supabase auth, the Electric read path, the write API) is never touched: those
// requests must fail honestly offline so the sync runtime reports `degraded` and the app renders its
// connection-needed states.
//
// No cache pruning. Content-hashed entries from superseded deploys and PGlite bumps are dead weight,
// never wrong answers, and every nuke-on-update scheme breaks offline return until the next full online
// boot — the capability itself (ADR-0010: accepted garbage; storage eviction is the backstop).

const CACHE = "board-runtime-v1";

// The ONE eager fetch. The first navigation of a first visit completes before this worker exists, so
// without precaching the shell here the document would only be captured on a SECOND navigation — and
// surviving the visit AFTER the last online one is precisely the capability. Cost is one HTML document.
// `cache: "reload"` bypasses the HTTP cache so the precached copy is the deployed one, not a stale hit.
// A failure here is not fatal: an install with no network still activates, and the navigation branch
// captures the document as soon as one succeeds.
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        const shell = new Request(self.registration.scope, { cache: "reload" });
        const response = await fetch(shell);
        if (isCacheable(response)) await cache.put(shell, response);
      } catch {
        // Offline (or blocked) at install — nothing to precache; runtime capture fills it later.
      }
      await self.skipWaiting();
    })(),
  );
});

// Take over the pages that loaded before this worker existed, so the very first session already
// captures assets instead of waiting for the next navigation.
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// The first-session backfill. Runtime capture has a structural blind spot: the ENTRY assets — the
// document's own script/style graph — are requested during document parse, before this worker exists,
// so on the capability's canonical timeline (ONE online session, close, return offline) they would never
// be cached and the offline return would die loading `index-*.js`. Once active, the page posts the
// same-origin URLs its session has already fetched (its performance resource entries — so still only
// what THIS visitor already downloaded, no manifest, no drive-by tax); anything not yet cached is
// fetched here, while the session is still online, and almost always answered by the HTTP cache.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (data == null || data.type !== "backfill" || !Array.isArray(data.urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Bounded and same-origin only: the page's own session can't have fetched more than this from us,
      // and a hostile message must not be able to turn the worker into a bulk fetcher.
      for (const raw of data.urls.slice(0, 200)) {
        try {
          const url = new URL(String(raw), self.location.origin);
          if (url.origin !== self.location.origin) continue;
          if (await cache.match(url, { ignoreVary: true })) continue;
          const response = await fetch(url);
          if (isCacheable(response)) await cache.put(url, response);
        } catch {
          // A single miss must not abort the rest; the asset stays uncached and network-dependent.
        }
      }
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Non-GET (writes go straight to the network), cross-origin, and non-http(s) schemes are left entirely
  // alone — an un-answered fetch event falls through to the browser's own handling.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  // Range requests must never be answered from a full 200 body, and a 206 must never be cached; leave
  // them to the network.
  if (request.headers.has("range")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstDocument(event, request));
    return;
  }
  event.respondWith(cacheFirstAsset(event, request));
});

// Navigations: network first. On a network failure fall back to the cached exact URL, then to the cached
// scope document — the SPA fallback, which is what answers a local-preview path URL like `/login` (the
// Pages build uses hash routing, so there the scope document IS the requested URL).
async function networkFirstDocument(event, request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) event.waitUntil(cache.put(request, response.clone()));
    return response;
  } catch (error) {
    const cached =
      (await cache.match(request, { ignoreVary: true })) ??
      (await cache.match(self.registration.scope, { ignoreVary: true }));
    if (cached) return cached;
    // Nothing cached and no network: let the rejection propagate rather than inventing an error page.
    throw error;
  }
}

// Everything else: cache first, then fetch and fill. Everything this branch sees is content-hashed —
// Vite fingerprints the bundle, the worker scripts AND the PGlite wasm/data blobs — so a stale hit is
// impossible; the only un-hashed same-origin URL, the document, belongs to the navigation branch.
async function cacheFirstAsset(event, request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheable(response)) event.waitUntil(cache.put(request, response.clone()));
  return response;
}

// Only ever store a full, same-origin 200. `type === "basic"` excludes opaque and opaque-redirect
// responses (`cache.put` throws on those); the status check excludes 206 partials and every error
// response, which must not become the answer a later offline boot gets.
function isCacheable(response) {
  return response.status === 200 && response.type === "basic";
}
