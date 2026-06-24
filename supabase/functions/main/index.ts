// Edge-runtime main service — the canonical Supabase self-hosted router.
//
// The `supabase/edge-runtime` container starts this one worker; every request to
// `/functions/v1/<name>` arrives here (Kong strips `/functions/v1`) and we spin up the per-function
// worker for `/<name>`. This is the stock self-hosted main service, unmodified except for pointing
// every worker at the shared import map so `@pgxsinkit/*` (mounted source) and the npm deps resolve.
//
// JWT verification is intentionally NOT done here: the board functions verify the GoTrue token
// themselves (`_shared/auth.ts`) so they stay portable to platforms where this router is absent.

declare const EdgeRuntime: {
  userWorkers: {
    create(options: Record<string, unknown>): Promise<{ fetch(request: Request): Promise<Response> }>;
  };
};

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);
  const serviceName = url.pathname.split("/")[1];

  if (!serviceName) {
    return Response.json({ message: "missing function name in request" }, { status: 400 });
  }

  const servicePath = `/home/deno/functions/${serviceName}`;

  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb: 256,
      workerTimeoutMs: 5 * 60 * 1000,
      noModuleCache: false,
      importMapPath: "/home/deno/functions/import_map.json",
      envVars: Object.entries(Deno.env.toObject()),
    });
    return await worker.fetch(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ message }, { status: 500 });
  }
});
