import type {
  BuildIdentity,
  MountedDataDirectory,
  PostgresBuild,
  RunningPostgres,
  WireSession,
} from "../../../packages/pgwasm/src/build";

/**
 * Test-only builds made from another build (the C build), each changing one thing about it. They let
 * the shared code be proven against the shapes a different build would have — an asynchronous wire,
 * notifications that arrive between exchanges, another identity — without that build.
 */

function wrapRunning(
  running: RunningPostgres,
  overrides: {
    session?: (session: WireSession) => WireSession;
    persist?: (relaxed: boolean, inner: (relaxed: boolean) => Promise<void>) => Promise<void>;
    release?: (afterFailedBoot: boolean) => void;
    withoutBlob?: boolean;
  },
): RunningPostgres {
  return {
    openSession: async () => {
      const session = await running.openSession();
      return overrides.session ? overrides.session(session) : session;
    },
    persist: (relaxed) =>
      overrides.persist ? overrides.persist(relaxed, (r) => running.persist(r)) : running.persist(relaxed),
    readEntries: () => running.readEntries(),
    blob: overrides.withoutBlob ? undefined : running.blob,
    shutdown: () => running.shutdown(),
    release: (options) => {
      overrides.release?.(options?.afterFailedBoot === true);
      return running.release(options);
    },
  };
}

function wrapMounted(
  mounted: MountedDataDirectory,
  wrap: (running: RunningPostgres) => RunningPostgres,
): MountedDataDirectory {
  return {
    readFile: (path) => mounted.readFile(path),
    createCluster: () => mounted.createCluster(),
    writeEntries: (entries) => mounted.writeEntries(entries),
    writeFile: (path, data) => mounted.writeFile(path, data),
    persist: () => mounted.persist(),
    start: async (options) => wrap(await mounted.start(options)),
    release: () => mounted.release(),
  };
}

function wrapBuild(
  inner: PostgresBuild,
  changes: { identity?: BuildIdentity; synchronousExchange?: boolean; blobDevice?: boolean },
  wrap: (running: RunningPostgres) => RunningPostgres,
): PostgresBuild {
  return {
    identity: changes.identity ?? inner.identity,
    capabilities: {
      ...inner.capabilities,
      ...(changes.synchronousExchange === undefined ? {} : { synchronousExchange: changes.synchronousExchange }),
      ...(changes.blobDevice === undefined ? {} : { blobDevice: changes.blobDevice }),
    },
    boot: async (request) => wrapMounted(await inner.boot(request), wrap),
  };
}

const nextMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Run the inner exchange, keeping copies of every chunk. */
function collect(session: WireSession, message: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  const pending = session.exchange(message, (chunk) => chunks.push(chunk.slice()));
  if (pending !== undefined) throw new Error("the decorated build must exchange synchronously");
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Split whole backend messages: a type byte, then a big-endian length that counts itself. */
function frames(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let offset = 0;
  while (offset + 5 <= bytes.byteLength) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, false);
    out.push(bytes.subarray(offset, offset + 1 + length));
    offset += 1 + length;
  }
  return out;
}

/**
 * Every exchange completes on a later macrotask, its reply delivered in single-message chunks: the
 * shape of a build whose wire is a real transport.
 */
export function asyncExchangeBuild(inner: PostgresBuild): PostgresBuild {
  return wrapBuild(inner, { synchronousExchange: false }, (running) =>
    wrapRunning(running, {
      session: (session) => ({
        onUnsolicited: undefined,
        close: () => session.close(),
        exchange: async (message, onData) => {
          const reply = collect(session, message);
          await nextMacrotask();
          for (const frame of frames(reply)) onData(frame);
        },
      }),
    }),
  );
}

/**
 * Notifications never ride on a reply: they are held back and delivered through `onUnsolicited` after
 * the exchange ends — how a notification from another session reaches a multi-session build's client.
 */
export function outOfBandNotifyBuild(inner: PostgresBuild): PostgresBuild {
  return wrapBuild(inner, { synchronousExchange: false }, (running) =>
    wrapRunning(running, {
      session: (session) => {
        const wrapped: WireSession = {
          onUnsolicited: undefined,
          close: () => session.close(),
          exchange: async (message, onData) => {
            const reply = collect(session, message);
            const held: Uint8Array[] = [];
            for (const frame of frames(reply)) {
              if (frame[0] === 0x41) held.push(frame.slice());
              else onData(frame);
            }
            await nextMacrotask();
            if (held.length > 0) {
              setTimeout(() => {
                for (const frame of held) wrapped.onUnsolicited?.(frame);
              }, 0);
            }
          },
        };
        return wrapped;
      },
    }),
  );
}

/** The same build under another identity: another name or data format, claiming no unmarked directory. */
export function foreignIdentityBuild(inner: PostgresBuild, identity: Partial<BuildIdentity>): PostgresBuild {
  return wrapBuild(
    inner,
    {
      identity: {
        name: "foreign",
        dataFormat: 1,
        claimsUnmarkedDirectories: false,
        release: "test",
        ...identity,
      },
    },
    (running) => running,
  );
}

/** Observe or fail the storage persists pgwasm schedules after statements. */
export function persistHookBuild(
  inner: PostgresBuild,
  hook: (relaxed: boolean, persist: (relaxed: boolean) => Promise<void>) => Promise<void>,
): PostgresBuild {
  return wrapBuild(inner, {}, (running) => wrapRunning(running, { persist: hook }));
}

/** Observe the release of a started database (`afterFailedBoot` when its boot failed after starting). */
export function releaseHookBuild(inner: PostgresBuild, hook: (afterFailedBoot: boolean) => void): PostgresBuild {
  return wrapBuild(inner, {}, (running) => wrapRunning(running, { release: hook }));
}

/** The same build without a `/dev/blob` device: the shape of a build that has none. */
export function noBlobDeviceBuild(inner: PostgresBuild): PostgresBuild {
  return wrapBuild(inner, { blobDevice: false }, (running) => wrapRunning(running, { withoutBlob: true }));
}

/**
 * The same build, with `hook` seeing every frontend message before the wire does: to count exchanges; to
 * throw, the way a broken build's wire would (pgwasm then fails the instance); or to return another
 * message, which the wire runs instead (a statement that fails the way SQL does, the instance intact).
 */
export function wireHookBuild(
  inner: PostgresBuild,
  hook: (message: Uint8Array) => Uint8Array | undefined | void,
): PostgresBuild {
  return wrapBuild(inner, {}, (running) =>
    wrapRunning(running, {
      session: (session) => ({
        onUnsolicited: undefined,
        close: () => session.close(),
        exchange: (message, onData) => session.exchange(hook(message) ?? message, onData),
      }),
    }),
  );
}
