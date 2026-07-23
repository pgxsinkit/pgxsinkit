// Tiny same-origin static server for the engine-capability probe page and its
// workers. Workers require same-origin loading, so a plain Bun static server for
// this one directory is enough — no vite, no dependencies.

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function contentType(pathname: string): string {
  const dot = pathname.lastIndexOf(".");
  const ext = dot >= 0 ? pathname.slice(dot) : "";
  return MIME[ext] ?? "application/octet-stream";
}

export function startProbeServer(port = 0) {
  const dir = import.meta.dir;
  return Bun.serve({
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      let pathname = url.pathname;
      if (pathname === "/" || pathname === "") {
        pathname = "/index.html";
      }
      // Reject traversal; only files inside this directory are served.
      if (pathname.includes("..")) {
        return new Response("bad path", { status: 400 });
      }
      const file = Bun.file(dir + pathname);
      if (!(await file.exists())) {
        return new Response("not found", { status: 404 });
      }
      return new Response(file, {
        headers: {
          "content-type": contentType(pathname),
          "cache-control": "no-store",
        },
      });
    },
  });
}

if (import.meta.main) {
  const server = startProbeServer(3939);
  console.log(`probe server on ${server.url.href}`);
}
