import { PGlite } from "@electric-sql/pglite";

async function run() {
  const db = new PGlite();

  await db.exec(`
    CREATE TABLE todos_synced (
      id UUID PRIMARY KEY,
      title TEXT,
      status TEXT,
      priority TEXT,
      author_id UUID,
      updated_at_us BIGINT
    );

    CREATE TABLE todos_overlay (
      id UUID PRIMARY KEY,
      title TEXT,
      status TEXT,
      priority TEXT,
      author_id UUID,
      overlay_kind VARCHAR(24) NOT NULL,
      local_updated_at_us BIGINT NOT NULL
    );

    CREATE VIEW todos_read_model AS
    SELECT
      id, title, status, priority, author_id,
      overlay_kind,
      local_updated_at_us
    FROM todos_overlay
    WHERE overlay_kind <> 'pending_delete'
    UNION ALL
    SELECT
      t.id, t.title, t.status, t.priority, t.author_id,
      'synced' AS overlay_kind,
      t.updated_at_us AS local_updated_at_us
    FROM todos_synced AS t
    WHERE NOT EXISTS (
      SELECT 1
      FROM todos_overlay AS o
      WHERE o.id = t.id
    );
  `);

  console.log("Seeding data (1000 rows)...");
  const syncedRows = 1000;
  const overlayRows = 200;

  await db.exec("BEGIN;");
  for (let i = 0; i < syncedRows; i++) {
    const id = `00000000-0000-0000-0000-${i.toString().padStart(12, "0")}`;
    await db.query(
      "INSERT INTO todos_synced (id, title, status, priority, updated_at_us) VALUES ($1, $2, $3, $4, $5)",
      [id, `Todo ${i}`, "todo", "medium", BigInt(i)],
    );
  }
  for (let i = 0; i < overlayRows; i++) {
    const id = `10000000-0000-0000-0000-${i.toString().padStart(12, "0")}`;
    await db.query(
      "INSERT INTO todos_overlay (id, title, status, priority, overlay_kind, local_updated_at_us) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, `Overlay Todo ${i}`, "todo", "medium", "create", BigInt(i)],
    );
  }
  await db.exec("COMMIT;");

  console.log("Analyzing...");
  await db.exec("ANALYZE todos_synced;");
  await db.exec("ANALYZE todos_overlay;");

  const targetId = "00000000-0000-0000-0000-000000000500";

  console.log("\nEXPLAIN for synced row lookup:");
  const explainSynced = await db.query<{ "QUERY PLAN": string }>(
    "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM todos_read_model WHERE id = $1",
    [targetId],
  );
  console.log(explainSynced.rows.map((row) => row["QUERY PLAN"]).join("\n"));

  console.log("\nBenchmarking 100 lookups...");
  const start = performance.now();
  for (let i = 0; i < 100; i++) {
    const id = `00000000-0000-0000-0000-${Math.floor(Math.random() * syncedRows)
      .toString()
      .padStart(12, "0")}`;
    await db.query(`SELECT id FROM todos_read_model WHERE id = $1`, [id]);
  }
  const end = performance.now();
  console.log(`Average latency: ${(end - start) / 100}ms`);
}

run().catch(console.error);
