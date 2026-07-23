// Supabase Edge Functions receive `/functions/v1/<function-name>/...` as `/<function-name>/...`.
// The shared board handlers normalize that function prefix before handing requests to pgxsinkit.
export function stripFunctionPrefix(request: Request, functionName: string): Request {
  const url = new URL(request.url);
  const prefix = `/${functionName}`;

  if (url.pathname === prefix) {
    url.pathname = "/";
  } else if (url.pathname.startsWith(`${prefix}/`)) {
    url.pathname = url.pathname.slice(prefix.length);
  }

  return new Request(url.toString(), request);
}
