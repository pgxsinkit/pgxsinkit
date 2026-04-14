import { beforeEach, describe, expect, it, vi } from "vitest";

const destroyMock = vi.fn<() => Promise<void>>(async () => undefined);
const createSyncClientMock = vi.fn<
  () => Promise<{ pglite: { name: string }; ready: Promise<void>; destroy: typeof destroyMock }>
>(async () => ({
  pglite: { name: "mock-db" },
  ready: Promise.resolve(),
  destroy: destroyMock,
}));

vi.mock("@pgxsinkit/client", () => ({
  createSyncClient: createSyncClientMock,
}));

describe("web pglite loader", () => {
  beforeEach(() => {
    destroyMock.mockClear();
    createSyncClientMock.mockClear();
  });

  it("shares one client for concurrent loads of the same identity", async () => {
    const { loadPGlite, getDemoDataDirForIdentity } = await import("../../apps/web/src/pglite");

    const [first, second] = await Promise.all([
      loadPGlite({ identity: "admin", authToken: "token-admin" }),
      loadPGlite({ identity: "admin", authToken: "token-admin" }),
    ]);

    expect(createSyncClientMock).toHaveBeenCalledTimes(1);
    expect(createSyncClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dataDir: getDemoDataDirForIdentity("admin"),
        authToken: "token-admin",
      }),
    );
    expect(first.client).toBe(second.client);
    expect(first.db).toBe(second.db);

    await first.dispose();
    expect(destroyMock).not.toHaveBeenCalled();

    await second.dispose();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it("skips read sync for the unauthenticated demo identity", async () => {
    const { loadPGlite, getDemoDataDirForIdentity } = await import("../../apps/web/src/pglite");

    const loaded = await loadPGlite({ identity: "none", authToken: null });

    expect(createSyncClientMock).toHaveBeenCalledTimes(1);
    expect(createSyncClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dataDir: getDemoDataDirForIdentity("none"),
        syncEnabled: false,
      }),
    );
    expect(createSyncClientMock).toHaveBeenCalledWith(expect.not.objectContaining({ authToken: expect.anything() }));

    await loaded.dispose();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });
});
