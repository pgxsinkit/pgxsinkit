// A tiny web-standard `fetch` router for the pgxsinkit server (ADR-0017). The server needs only
// exact-path GET/POST routing, a small CORS layer, and an error boundary, so a focused router keeps
// `@pgxsinkit/server` dependency-light and runnable on any `fetch` runtime — no web framework required.
// `proxyElectricShapeRequest` and the mutation handler are plain `(Request) => Response` functions, so
// they can equally be mounted in someone else's framework.

import { resolveCorsOrigin } from "./cors-origin";

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface CorsConfig {
  /** Exact origins, or a `"*"` entry to allow every origin by reflection (see {@link resolveCorsOrigin}). */
  origins: string[];
  allowMethods: string[];
  allowHeaders: string[];
}

/** A CORS scope is matched either by exact pathname or by pathname prefix (e.g. `/api/`). */
export type CorsScope = { exact: string } | { prefix: string };

export type RouterErrorHandler = (error: unknown, request: Request) => Response | Promise<Response>;

export class FetchRouter {
  readonly #routes = new Map<string, FetchHandler>();
  #cors: CorsConfig | undefined;
  #corsMatchers: Array<(pathname: string) => boolean> = [];
  #onError: RouterErrorHandler | undefined;

  get(path: string, handler: FetchHandler): void {
    this.#routes.set(`GET ${path}`, handler);
  }

  post(path: string, handler: FetchHandler): void {
    this.#routes.set(`POST ${path}`, handler);
  }

  setCors(config: CorsConfig, scopes: CorsScope[]): void {
    this.#cors = config;
    this.#corsMatchers = scopes.map((scope) =>
      "exact" in scope
        ? (pathname: string) => pathname === scope.exact
        : (pathname: string) => pathname.startsWith(scope.prefix),
    );
  }

  setErrorHandler(handler: RouterErrorHandler): void {
    this.#onError = handler;
  }

  readonly fetch = async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    const corsApplies = this.#cors !== undefined && this.#corsMatchers.some((matches) => matches(pathname));

    // A preflight short-circuits before routing, exactly as a CORS middleware mounted on the scope would.
    if (request.method === "OPTIONS" && corsApplies) {
      return this.#preflight(request);
    }

    let response: Response;
    const handler = this.#routes.get(`${request.method} ${pathname}`);
    if (handler) {
      try {
        response = await handler(request);
      } catch (error) {
        if (!this.#onError) {
          throw error;
        }
        response = await this.#onError(error, request);
      }
    } else {
      response = new Response("Not Found", { status: 404 });
    }

    return corsApplies ? this.#withCorsHeaders(request, response) : response;
  };

  #allowedOrigin(request: Request): string | null {
    return this.#cors ? resolveCorsOrigin(request, this.#cors.origins) : null;
  }

  #preflight(request: Request): Response {
    const headers = new Headers();
    const origin = this.#allowedOrigin(request);
    if (origin) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.append("Vary", "Origin");
    }
    if (this.#cors) {
      headers.set("Access-Control-Allow-Methods", this.#cors.allowMethods.join(","));
      // Echo what the browser asks to send (e.g. a deployment gateway's `apikey` alongside the
      // toolkit's `Authorization`), falling back to the declared list — so a client header the app
      // legitimately sets is never rejected just because it wasn't enumerated here.
      headers.set(
        "Access-Control-Allow-Headers",
        request.headers.get("access-control-request-headers") ?? this.#cors.allowHeaders.join(","),
      );
    }
    return new Response(null, { status: 204, headers });
  }

  #withCorsHeaders(request: Request, response: Response): Response {
    const origin = this.#allowedOrigin(request);
    if (!origin) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", origin);
    headers.append("Vary", "Origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}
