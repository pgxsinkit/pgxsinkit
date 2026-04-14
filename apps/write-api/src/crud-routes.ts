import type { Hono } from "hono";
import { z } from "zod";

import type { TableSpec } from "@pgxsinkit/contracts";

interface CrudTableSpec<TCreate, TUpdate, TRecord> extends Pick<
  TableSpec<TCreate, TUpdate, TRecord>,
  "name" | "routes" | "schemas"
> {}

export interface CrudRouteSpec<TId, TCreate, TUpdate, TRecord> {
  table: CrudTableSpec<TCreate, TUpdate, TRecord>;
  idSchema: z.ZodType<TId>;
  notFoundMessage?: string;
  list: () => Promise<TRecord[]>;
  create: (payload: TCreate) => Promise<TRecord>;
  update: (id: TId, payload: TUpdate) => Promise<TRecord | null>;
  remove: (id: TId) => Promise<boolean>;
}

export type AnyCrudRouteSpec = CrudRouteSpec<any, any, any, any>;

export function registerCrudRoutes<TId, TCreate, TUpdate, TRecord>(
  app: Hono,
  spec: CrudRouteSpec<TId, TCreate, TUpdate, TRecord>,
) {
  const basePath = spec.table.routes?.basePath;

  if (!basePath) {
    throw new Error(`Missing routes.basePath for table ${spec.table.name}`);
  }

  app.get(basePath, async (context) => {
    return context.json(z.array(spec.table.schemas.recordSchema).parse(await spec.list()));
  });

  app.post(basePath, async (context) => {
    const payload = spec.table.schemas.createSchema.parse(await context.req.json());
    return context.json(await spec.create(payload), 201);
  });

  app.patch(`${basePath}/:id`, async (context) => {
    const id = spec.idSchema.parse(context.req.param("id"));
    const payload = spec.table.schemas.updateSchema.parse(await context.req.json());
    const updated = await spec.update(id, payload);

    if (updated === null) {
      return context.json({ message: spec.notFoundMessage ?? "Record not found" }, 404);
    }

    return context.json(updated);
  });

  app.delete(`${basePath}/:id`, async (context) => {
    const id = spec.idSchema.parse(context.req.param("id"));
    const removed = await spec.remove(id);

    if (!removed) {
      return context.json({ message: spec.notFoundMessage ?? "Record not found" }, 404);
    }

    return context.body(null, 204);
  });
}
