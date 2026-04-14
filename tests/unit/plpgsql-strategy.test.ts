import { demoSyncRegistry } from "@pgxsinkit/demo";

import { buildPlpgsqlBatchFunctionDdl } from "../../packages/server/src/mutations/bulk/plpgsql-strategy";

describe("plpgsql batch function generator", () => {
  it("stamps managed fields instead of reading them from payload", () => {
    const ddl = buildPlpgsqlBatchFunctionDdl(demoSyncRegistry);

    expect(ddl).toContain('"owner_id", "modified_by", "created_at_us", "updated_at_us"');
    expect(ddl).toContain(
      "auth.uid(), auth.uid(), CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)",
    );
    expect(ddl).toContain('"modified_by" = auth.uid()');
    expect(ddl).toContain('"updated_at_us" = CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)');
    expect(ddl).not.toContain("($1->>'owner_id')::uuid");
    expect(ddl).not.toContain("($1->>'modified_by')::uuid");
    expect(ddl).not.toContain("($1->>'created_at_us')::bigint");
    expect(ddl).not.toContain("($1->>'updated_at_us')::bigint");
  });
});
