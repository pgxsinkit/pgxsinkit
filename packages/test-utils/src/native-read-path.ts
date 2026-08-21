import {
  createCircuitsEngineClient,
  createStreamGate,
  importStreamTokenKey,
  type CircuitsEngineClient,
  type EntitlementSet,
} from "@pgxsinkit/server";

import type { IntegrationEnv } from "./env";

/**
 * The native read path, stood up in-process for a test lane (ADR-0055 decision 8).
 *
 * The harness runs postgres, durable-streams and the Circuits engine in containers; the CONTROL
 * PLANE and the EDGE are TypeScript, so they run here. That is not a convenience — it is what lets a
 * test revoke an entitlement between two polls and watch the next read get refused, which no
 * container boundary would allow.
 *
 * The edge gets its own origin rather than sharing the control plane's. In production it is the
 * CDN-frontable surface and the control plane is not, so folding them onto one port in tests would
 * quietly let a same-origin assumption compile that production would then break.
 */
export interface NativeReadPathOptions {
  env: Pick<IntegrationEnv, "circuitsEngineUrl" | "durableStreamsUrl">;
  /**
   * The shared tier's entitlement set. Omit for a registry of private-tier shapes only — subscribe
   * and the edge then both refuse a shared grant instead of inventing an answer.
   */
  entitlements?: EntitlementSet;
  /** Override ADR-0055's 5-minute stream-token lifetime, e.g. to prove the re-mint path. */
  ttlSeconds?: number;
  /** Per-request extra params for the private tier's row filters. */
  resolveShapeParams?: (request: Request) => Record<string, unknown> | undefined;
  /** The HMAC secret both halves share. Fixed by default — one process mints and verifies. */
  secret?: string;
}

export interface NativeReadPath {
  /** Spread straight into `createSyncServer({ readPath })`. */
  readPath: {
    engine: CircuitsEngineClient;
    entitlements?: EntitlementSet;
    key: CryptoKey;
    ttlSeconds?: number;
    resolveShapeParams?: (request: Request) => Record<string, unknown> | undefined;
  };
  /** `createSyncClient({ streamBaseUrl })` — the edge, on its own origin. */
  streamBaseUrl: string;
  engine: CircuitsEngineClient;
  key: CryptoKey;
  stop: () => Promise<void>;
}

const STREAM_MOUNT_PATH = "/v1/stream";
const DEFAULT_SECRET = "pgxsinkit-integration-stream-token-secret";

export async function startNativeReadPath(options: NativeReadPathOptions): Promise<NativeReadPath> {
  const engine = createCircuitsEngineClient({ baseUrl: options.env.circuitsEngineUrl });
  const key = await importStreamTokenKey(options.secret ?? DEFAULT_SECRET);

  const handleStreamRead = createStreamGate({
    key,
    ...(options.entitlements ? { entitlements: options.entitlements } : {}),
    durableStreamsUrl: options.env.durableStreamsUrl,
  });

  const edge = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (!pathname.startsWith(`${STREAM_MOUNT_PATH}/`)) {
        return new Response("not found", { status: 404 });
      }
      // `now` is the request-start time so a long poll held across the token's expiry is judged by
      // when it started, exactly as a real edge must judge it.
      return handleStreamRead(request, pathname.slice(STREAM_MOUNT_PATH.length + 1), Math.floor(Date.now() / 1000));
    },
  });

  return {
    readPath: {
      engine,
      ...(options.entitlements ? { entitlements: options.entitlements } : {}),
      key,
      ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
      ...(options.resolveShapeParams ? { resolveShapeParams: options.resolveShapeParams } : {}),
    },
    streamBaseUrl: `http://127.0.0.1:${edge.port}${STREAM_MOUNT_PATH}`,
    engine,
    key,
    stop: async () => {
      await edge.stop(true);
    },
  };
}

/** A sync server hosted over HTTP, its edge, and the two URLs a client needs to reach them. */
export interface NativeSyncStack<TServer> {
  server: TServer;
  /** `createSyncClient({ controlPlaneUrl })` — subscribe, re-mint and the barrier. */
  controlPlaneUrl: string;
  /** `createSyncClient({ streamBaseUrl })` — the edge. */
  streamBaseUrl: string;
  /** Tear down the HTTP server, the edge, and the sync server, in that order. */
  stop: () => Promise<void>;
}

export interface NativeSyncStackOptions<TServer> extends NativeReadPathOptions {
  /**
   * Build the sync server around the read path this helper just stood up.
   *
   * A callback rather than a registry+db pair because the ORDER is forced — the edge must exist
   * before `createSyncServer` can be given a `readPath`, and the server must exist before it can be
   * hosted and its `controlPlaneUrl` known. Taking the server's own options instead would mean
   * restating every knob `createSyncServer` has, and the lane uses a good many of them.
   */
  createServer: (readPath: NativeReadPath["readPath"]) => TServer;
}

/**
 * The whole native read path for one test file: edge, control plane, and an HTTP server in front of
 * it.
 *
 * This is what replaces the Electric lane's single `electricUrl` — there is no longer one URL a test
 * can be handed, because subscribe is now a conversation with a control plane that only this process
 * can host.
 */
export async function startNativeSyncStack<
  TServer extends { fetch: (request: Request) => Promise<Response>; stop: () => Promise<void> },
>(options: NativeSyncStackOptions<TServer>): Promise<NativeSyncStack<TServer>> {
  const readPath = await startNativeReadPath(options);
  const server = options.createServer(readPath.readPath);
  const http = Bun.serve({ port: 0, idleTimeout: 0, fetch: server.fetch });

  return {
    server,
    controlPlaneUrl: `http://127.0.0.1:${http.port}`,
    streamBaseUrl: readPath.streamBaseUrl,
    stop: async () => {
      await http.stop(true);
      await readPath.stop();
      await server.stop();
    },
  };
}
