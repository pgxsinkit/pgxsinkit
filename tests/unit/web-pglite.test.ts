import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

const stopMock = mock(async (): Promise<void> => undefined);
const createSyncClientMock = mock(
  async (_options: unknown): Promise<{ pglite: { name: string }; ready: Promise<void>; stop: typeof stopMock }> => ({
    pglite: { name: "mock-db" },
    ready: Promise.resolve(),
    stop: stopMock,
  }),
);

describe("web pglite loader", () => {
  beforeAll(async () => {
    await mock.module("@pgxsinkit/client", () => ({
      createSyncClient: createSyncClientMock,
    }));
  });

  afterAll(() => mock.restore());

  beforeEach(() => {
    stopMock.mockClear();
    createSyncClientMock.mockClear();
  });

  it("shares one client for concurrent loads of the same identity", async () => {
    const { loadPGlite, getDemoDataDirForIdentity } = await import("../../apps/web/src/pglite");

    const [first, second] = await Promise.all([
      loadPGlite({ identity: "admin", getAuthToken: async () => "token-admin" }),
      loadPGlite({ identity: "admin", getAuthToken: async () => "token-admin" }),
    ]);

    expect(createSyncClientMock).toHaveBeenCalledTimes(1);
    expect(createSyncClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dataDir: getDemoDataDirForIdentity("admin"),
        syncEnabled: true,
        getAuthToken: expect.any(Function),
      }),
    );

    const createSyncClientArgs = createSyncClientMock.mock.calls[0]?.[0] as
      | { getAuthToken?: () => Promise<string | undefined> }
      | undefined;
    expect(await createSyncClientArgs?.getAuthToken?.()).toBe("token-admin");

    expect(first.client).toBe(second.client);
    expect(first.db).toBe(second.db);

    await first.dispose();
    expect(stopMock).not.toHaveBeenCalled();

    await second.dispose();
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it("skips read sync for the unauthenticated demo identity", async () => {
    const { loadPGlite, getDemoDataDirForIdentity } = await import("../../apps/web/src/pglite");

    const loaded = await loadPGlite({ identity: "none", getAuthToken: async () => null });

    expect(createSyncClientMock).toHaveBeenCalledTimes(1);
    expect(createSyncClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dataDir: getDemoDataDirForIdentity("none"),
        syncEnabled: false,
        getAuthToken: expect.any(Function),
      }),
    );

    const createSyncClientArgs = createSyncClientMock.mock.calls[0]?.[0] as
      | { getAuthToken?: () => Promise<string | undefined> }
      | undefined;
    expect(await createSyncClientArgs?.getAuthToken?.()).toBeUndefined();

    await loaded.dispose();
    expect(stopMock).toHaveBeenCalledTimes(1);
  });
});
