import { drizzle } from "drizzle-orm/postgres-js";
import { defineRelations } from "drizzle-orm/relations";
import postgres from "postgres";

import { boardSyncRegistry } from "@pgxsinkit/board-schema";
import { buildRegistrySchema } from "@pgxsinkit/server";

const schema = buildRegistrySchema(boardSyncRegistry);
const relations = defineRelations(schema);

export function createDenoBoardDb(connectionString: string) {
  const url = new URL(connectionString);
  console.log("[pgxsinkit-timing]", JSON.stringify({ route: "db-connect", host: url.hostname, port: url.port }));
  const client = postgres(connectionString, { prepare: false });

  const t0 = performance.now();
  void client`select 1`
    .then(() => {
      const connectMs = Math.round(performance.now() - t0);
      const t1 = performance.now();
      return client`select 1`.then(() => {
        console.log(
          "[pgxsinkit-timing]",
          JSON.stringify({ route: "db-probe", connectMs, rttMs: Math.round(performance.now() - t1) }),
        );
      });
    })
    .catch((error: unknown) => {
      console.log(
        "[pgxsinkit-timing]",
        JSON.stringify({ route: "db-probe", error: error instanceof Error ? error.message : String(error) }),
      );
    });

  return drizzle({ client, relations });
}
