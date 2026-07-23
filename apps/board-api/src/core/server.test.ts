import { describe, expect, test } from "bun:test";

import { createBoardBackendFetch } from "./server";

describe("board backend fetch", () => {
  test("dispatches canonical board function paths", async () => {
    const fetch = createBoardBackendFetch({
      boardWrite: async () => new Response("write"),
      boardSync: async () => new Response("sync"),
    });

    await expect((await fetch(new Request("http://localhost/board-write"))).text()).resolves.toBe("write");
    await expect((await fetch(new Request("http://localhost/board-sync?table=team"))).text()).resolves.toBe("sync");
  });

  test("serves the Supabase chart health path", async () => {
    const fetch = createBoardBackendFetch({
      boardWrite: async () => new Response("write"),
      boardSync: async () => new Response("sync"),
    });

    expect((await fetch(new Request("http://localhost/_internal/health"))).status).toBe(200);
  });
});
