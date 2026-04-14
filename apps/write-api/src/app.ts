import { Hono } from "hono";
import { cors } from "hono/cors";
import { ZodError } from "zod";

import { registerCrudRoutes, type AnyCrudRouteSpec } from "./crud-routes";

interface WriteApiDependencies {
  allowedOrigins?: string[];
  routeSpecs?: AnyCrudRouteSpec[];
}

export function createWriteApi({
  allowedOrigins = ["http://localhost:5173", "http://localhost:5174"],
  routeSpecs = [],
}: WriteApiDependencies = {}) {
  const app = new Hono();

  app.use(
    "/api/*",
    cors({
      origin: allowedOrigins,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );

  app.onError((error, context) => {
    console.error("write-api error", error);

    if (error instanceof ZodError) {
      return context.json(
        {
          message: "Validation failed",
          issues: error.issues,
        },
        400,
      );
    }

    return context.json(
      {
        message: error instanceof Error ? error.message : "Unexpected error",
      },
      500,
    );
  });

  app.get("/health", (context) => {
    return context.json({ ok: true });
  });

  for (const routeSpec of routeSpecs) {
    registerCrudRoutes(app, routeSpec);
  }

  return app;
}
