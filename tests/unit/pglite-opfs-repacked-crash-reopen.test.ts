/* oxlint-disable typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return real promises typed as void */
/**
 * Crash and reopen: what a client sees after the page or worker dies between a commit and the store's
 * next sync, with PGlite as the engine through the package's own factory.
 *
 * The platform is `CrashOpfsDirectory` (test/support/crash-opfs.ts): the directory the factory's
 * `OpfsRepackedPort` talks to, which numbers every call the store core makes and loses power at a
 * chosen call index. One traced run of the workload per durability mode yields the call sequence; each
 * kill point is a structural locator over that trace ("the WAL write carrying commit 5's record", "the
 * metadata append naming its extension", "the flush after it"), resolved to an index, and a second run
 * loses power exactly there — the test asserts the second run is the traced run call for call, so the
 * kill landed on the operation it names. What the power left is then materialized four ways (see
 * `CrashImageModel`) and each distinct image is reopened, first by the store alone and then through
 * the factory, and inspected.
 *
 * What each mode PROMISES (README "Durability"; asserted as a floor):
 *
 * - `strict`: every commit whose query returned — the awaited host sync ran a strict sync before it
 *   returned, so this holds even in the `flushed` image, where nothing unflushed survived.
 * - `relaxed`: every commit covered by the last STRICT boundary — an explicit `strictSync()`, a repack
 *   activation (forced strict), or a close. Its amortization flush is arena-only and promises nothing
 *   about commits; neither does anything unflushed.
 *
 * What each image SHOWS beyond the promise is asserted too, exactly, as documentation of the store as
 * it is today — not as a promise. Those expectations are the gate a change to the store's write
 * pattern has to pass (the rejected levers of the pglite-v-pgrust 2026-09-24 store-levers note: arena
 * growth in 4 MiB chunks, coalesced extent writes, skipping all-zero writes past the high-water mark,
 * and batching metadata-log appends until the next sync): a lever that moves one of them must say so.
 *
 * Every reopen also asserts consistency: the store opens, recovery replays exactly the complete
 * metadata frames the image holds (a torn frame is never applied), PGlite starts and runs crash
 * recovery, the table is a prefix of the commit sequence, an index scan and a sequential scan return
 * the same rows, every payload is the one written, `verify_heapam` and `bt_index_check(heapallindexed)`
 * find nothing (PGlite runs `data_checksums=on`, so every page those read is checksum-verified: no
 * partially applied block), and the recovered store accepts a new commit and a clean close.
 *
 * PGlite always boots Postgres with `-F` (`fsync=off`): its guest never fsyncs, in either mode, and its
 * durability is entirely the factory's awaited host sync. The pgrust engine is not in this repo — its
 * host (the pglite-v-pgrust bench's client) reaches this same store through the sync broker and the
 * WASI adapter, and since 2026-09-24 boots relaxed stores with `fsync=off` too, so a relaxed pgrust
 * store now reaches the platform on the same boundaries as a relaxed PGlite store here. This file
 * covers the store core under PGlite; it does not cover that host.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { dataDir as prepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";
import { amcheck } from "@electric-sql/pglite/contrib/amcheck";

import { FS_ERRNO, StoreFailedError } from "../../packages/pglite-opfs-repacked/src/core/errors";
import { RepackedVfs } from "../../packages/pglite-opfs-repacked/src/core/repacked-vfs";
import { OpfsRepackedPort } from "../../packages/pglite-opfs-repacked/src/opfs-port";
import { createOpfsRepackedPGlite } from "../../packages/pglite-opfs-repacked/src/pglite-factory";
import type { OpfsRepackedPGlite } from "../../packages/pglite-opfs-repacked/src/pglite-factory";
import { CrashOpfsDirectory } from "../../packages/pglite-opfs-repacked/test/support/crash-opfs";
import type {
  CrashCall,
  CrashImage,
  CrashImageModel,
} from "../../packages/pglite-opfs-repacked/test/support/crash-opfs";

type Durability = "relaxed" | "strict";
/** The engine every open here builds: PGlite through the factory, with `amcheck` loaded. */
type CrashPGlite = OpfsRepackedPGlite<{ amcheck: typeof amcheck }>;

const MODELS: readonly CrashImageModel[] = ["applied", "flushed", "arena-applied", "metadata-applied"];
const TEST_TIMEOUT_MS = 120_000;
const BULK_FIRST_ID = 1001;
/** Enough rows that the bulk commit writes well over the 4 MiB relaxed amortization threshold. */
const BULK_ROWS = 2000;
/** A row the reopened store must accept after recovery; never part of the commit sequence. */
const PROBE_ID = 999_999;

// ── The workload ─────────────────────────────────────────────────────────────────────────────────────

/** 1,800 hex digits: incompressible for pglz, so four rows fill a heap page and the heap keeps extending. */
function hexPayload(seed: number, length = 1800): string {
  let state = Math.imul(seed + 1, 2_654_435_761) >>> 0;
  let text = "";
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    text += ((state >>> 16) & 15).toString(16);
  }
  return text;
}

const BULK_PREFIX = hexPayload(0, 1790);

function payloadFor(id: number): string {
  return id >= BULK_FIRST_ID ? `${BULK_PREFIX}${id}` : hexPayload(id);
}

function digest(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

interface Step {
  readonly name: string;
  /** The rows this step's commit makes visible; absent for a step that commits nothing. */
  readonly ids?: readonly number[];
  run(pg: CrashPGlite): Promise<unknown>;
}

function insertOne(id: number): Step {
  return {
    name: `c${id}`,
    ids: [id],
    run: (pg) => pg.query("INSERT INTO crash_rows (id, payload) VALUES ($1, $2)", [id, payloadFor(id)]),
  };
}

/**
 * Commits 1–8 insert one row each; commit 9 ("bulk") inserts 2,000 in one statement; then an explicit
 * `strictSync()` (the one strict operation the sync layer above the store calls — pgxsinkit's commitment
 * barrier does); then commits 10–12 insert one row each.
 */
const STEPS: readonly Step[] = [
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(insertOne),
  {
    name: "bulk",
    ids: Array.from({ length: BULK_ROWS }, (_, offset) => BULK_FIRST_ID + offset),
    run: (pg) =>
      pg.query(
        `INSERT INTO crash_rows (id, payload)
         SELECT g, $1 || g::text FROM generate_series(${BULK_FIRST_ID}, ${BULK_FIRST_ID + BULK_ROWS - 1}) AS g`,
        [BULK_PREFIX],
      ),
  },
  { name: "strictSync", run: (pg) => pg.strictSync() },
  ...[10, 11, 12].map(insertOne),
];

const COMMITS = STEPS.filter((step): step is Step & { ids: readonly number[] } => step.ids !== undefined);

function commitsAmong(stepNames: readonly string[]): number {
  return COMMITS.filter((commit) => stepNames.includes(commit.name)).length;
}

function commitsBefore(stepName: string): number {
  return commitsAmong(
    STEPS.slice(
      0,
      STEPS.findIndex((step) => step.name === stepName),
    ).map((step) => step.name),
  );
}

/** How many leading commits the visible ids are, or a thrown error if they are not a commit prefix. */
function visibleCommitPrefix(ids: readonly number[]): number {
  const visible = new Set(ids);
  let prefix = 0;
  while (prefix < COMMITS.length && COMMITS[prefix]!.ids.every((id) => visible.has(id))) prefix += 1;
  const expected = COMMITS.slice(0, prefix).flatMap((commit) => commit.ids);
  const outside = ids.filter((id) => !expected.includes(id));
  if (outside.length > 0 || expected.length !== ids.length) {
    throw new Error(
      `visible rows are not a prefix of the commit sequence: ${prefix} whole commits, ` +
        `${outside.length} rows outside them (first ${outside.slice(0, 5).join(",")})`,
    );
  }
  return prefix;
}

async function openStore(directory: CrashOpfsDirectory, durability: Durability): Promise<CrashPGlite> {
  return createOpfsRepackedPGlite({ directory, durability, pglite: { extensions: { amcheck } } });
}

async function createSeed(): Promise<CrashImage> {
  const directory = new CrashOpfsDirectory();
  const pg = await createOpfsRepackedPGlite({
    directory,
    durability: "strict",
    extentSize: 65_536,
    pglite: { loadDataDir: await prepopulatedDataDir(), extensions: { amcheck } },
  });
  await pg.exec("CREATE EXTENSION amcheck");
  await pg.exec("CREATE TABLE crash_rows (id integer PRIMARY KEY, payload text NOT NULL)");
  await pg.close();
  return directory.image("applied");
}

// ── The traced run and the kill points ───────────────────────────────────────────────────────────────

interface Window {
  /** The first call the step made. */
  readonly start: number;
  /** The first call after the step returned. */
  readonly end: number;
}

interface Trace {
  readonly calls: readonly CrashCall[];
  readonly windows: ReadonlyMap<string, Window>;
  /** The first call of the orderly `close()` after the last step. */
  readonly closeStart: number;
}

async function traceWorkload(seed: CrashImage, durability: Durability): Promise<Trace> {
  const directory = CrashOpfsDirectory.fromImage(seed);
  const pg = await openStore(directory, durability);
  const windows = new Map<string, Window>();
  for (const step of STEPS) {
    const start = directory.nextCallIndex;
    await step.run(pg);
    windows.set(step.name, { start, end: directory.nextCallIndex });
  }
  const closeStart = directory.nextCallIndex;
  await pg.close();
  return { calls: directory.calls(), windows, closeStart };
}

const isMetadataFile = (file: CrashCall["file"]) => file === "metadata-a.bin" || file === "metadata-b.bin";
const isArenaWrite = (call: CrashCall) => call.kind === "write" && call.file === "arena.bin";
/** A metadata-log frame append. A repack writes its new base at offset 0; every append lands after one. */
const isMetadataAppend = (call: CrashCall) => call.kind === "write" && isMetadataFile(call.file) && call.offset > 0;

function windowOf(trace: Trace, step: string): Window {
  const window = trace.windows.get(step);
  if (window === undefined) throw new Error(`the trace has no step ${step}`);
  return window;
}

function callsIn(trace: Trace, window: Window): readonly CrashCall[] {
  return trace.calls.slice(window.start, window.end);
}

function last(calls: readonly CrashCall[], predicate: (call: CrashCall) => boolean, what: string): CrashCall {
  const found = calls.findLast(predicate);
  if (found === undefined) throw new Error(`the traced workload has no ${what}`);
  return found;
}

/**
 * The write pattern of one committing step, as the store makes it: the last metadata append in the step
 * (the materialized resize naming the step's heap extension, appended at the step's host sync), the
 * last arena write before it (the WAL write carrying the commit record), and the flushes after it.
 */
function commitPattern(trace: Trace, step: string) {
  const calls = callsIn(trace, windowOf(trace, step));
  const append = last(calls, isMetadataAppend, `metadata append in ${step}`);
  const arenaWrite = last(
    calls.filter((call) => call.index < append.index),
    isArenaWrite,
    `arena write before ${step}'s last metadata append`,
  );
  const flushes = calls.filter((call) => call.kind === "flush" && call.index > append.index);
  return { arenaWrite, append, flushes, window: windowOf(trace, step) };
}

interface KillAt {
  readonly index: number;
  readonly tornBytes: number;
}

/**
 * What one kill point showed in one mode: the step the power died in, and the number of leading commits
 * each image recovered (1–8 are c1–c8, 9 is the bulk, 10–12 are c10–c12). An OBSERVATION of the store
 * as it is today, not a promise — the promise is the floor every test asserts first.
 */
interface Observation {
  readonly dying: string;
  readonly images: Record<CrashImageModel, Outcome>;
}

interface KillPoint {
  readonly name: string;
  locate(trace: Trace, durability: Durability): KillAt;
  /** The modes this point runs in, each with what it showed. */
  readonly observed: Partial<Record<Durability, Observation>>;
}

const at = (index: number, tornBytes = 0): KillAt => ({ index, tornBytes });

function died(step: string, images: Record<CrashImageModel, Outcome>): Observation {
  return { dying: step, images };
}

/** Every image recovered the same commits. */
function every(commits: number): Record<CrashImageModel, Outcome> {
  return { applied: commits, flushed: commits, "arena-applied": commits, "metadata-applied": commits };
}

/**
 * The images split by the ARENA alone: those that kept its unflushed writes recovered `arenaKept`, those
 * that lost them `arenaLost`, whatever happened to the metadata files. PGlite's WAL segment is
 * preallocated and written in place, so no WAL record needs a metadata frame to be found, and redo
 * re-extends any relation whose growth the metadata log lost.
 */
function byArena(arenaKept: number, arenaLost: number): Record<CrashImageModel, Outcome> {
  return { applied: arenaKept, flushed: arenaLost, "arena-applied": arenaKept, "metadata-applied": arenaLost };
}

const KILL_POINTS: readonly KillPoint[] = [
  {
    name: "c5: mid arena write (the WAL write carrying its commit record, torn in half)",
    locate: (trace) => {
      const { arenaWrite } = commitPattern(trace, "c5");
      return at(arenaWrite.index, Math.floor(arenaWrite.length / 2));
    },
    // The half that landed does not hold c5's commit record whole, so the record fails its CRC and
    // redo ends before c5 in every image.
    observed: { strict: died("c5", every(4)), relaxed: died("c5", every(4)) },
  },
  {
    name: "c5: after its arena writes, before the metadata append naming its extension",
    locate: (trace) => at(commitPattern(trace, "c5").append.index),
    // c5's WAL write landed before the power went: an image that kept the arena's unflushed writes
    // replays c5, although its caller never saw it succeed. Without them the image still has c2–c4 —
    // strict synced them; relaxed got them from the zero barrier c5's own allocation of a reused extent
    // flushed through the arena ahead of c5's WAL write.
    observed: { strict: died("c5", byArena(5, 4)), relaxed: died("c5", byArena(5, 4)) },
  },
  {
    name: "c5: mid metadata append (torn in half)",
    locate: (trace) => {
      const { append } = commitPattern(trace, "c5");
      return at(append.index, Math.floor(append.length / 2));
    },
    // The torn frame is never replayed (the store-level frame count proves it), and losing it loses
    // nothing: it only named c5's heap extension, which redo re-creates.
    observed: { strict: died("c5", byArena(5, 4)), relaxed: died("c5", byArena(5, 4)) },
  },
  {
    // Strict: the arena flush of c5's strict sync dies. Relaxed flushes nothing in c5, so the first call
    // after the append is the next commit's: c5 RETURNED, and nothing of it was flushed.
    name: "c5: after the metadata append, before the flush",
    locate: (trace, durability) => {
      const { flushes, window } = commitPattern(trace, "c5");
      return at(durability === "strict" ? flushes[0]!.index : window.end);
    },
    // Relaxed: c5 was acknowledged, and without the arena's unflushed writes it is gone.
    observed: { strict: died("c5", byArena(5, 4)), relaxed: died("c6", byArena(5, 4)) },
  },
  {
    name: "c5: between the arena flush and the metadata flush",
    locate: (trace) => at(commitPattern(trace, "c5").flushes[1]!.index),
    // The arena flush made c5's WAL durable; the unflushed metadata only named its extension.
    observed: { strict: died("c5", every(5)) },
  },
  {
    name: "c5: after the flush (the commit returned)",
    locate: (trace) => at(commitPattern(trace, "c5").window.end),
    // The power dies in c6's WAL write: nothing of c6 reached the platform.
    observed: { strict: died("c6", every(5)) },
  },
  {
    name: "c8 returned, before the next sync",
    locate: (trace) => at(windowOf(trace, "bulk").start),
    // Relaxed: c5–c8 were acknowledged and exist only in unflushed arena writes — its documented loss
    // window. (The power dies in the first call after c8, one of the bulk's reads.)
    observed: { strict: died("bulk", every(8)), relaxed: died("bulk", byArena(8, 4)) },
  },
  {
    name: "bulk: mid arena write halfway through the statement (torn in half)",
    locate: (trace) => {
      const writes = callsIn(trace, windowOf(trace, "bulk")).filter(isArenaWrite);
      const middle = writes[Math.floor(writes.length / 2)]!;
      return at(middle.index, Math.floor(middle.length / 2));
    },
    // All or nothing for the bulk. Relaxed: the zero barriers earlier in the bulk flushed the arena,
    // which made c5–c8 durable in every image.
    observed: { strict: died("bulk", every(8)), relaxed: died("bulk", every(8)) },
  },
  {
    // Strict: the arena flush of the bulk's strict sync. Relaxed: the arena-only AMORTIZATION flush the
    // bulk's 8 MB of arena writes make due at its host sync.
    name: "bulk: after its last metadata append, before the flush",
    locate: (trace) => at(commitPattern(trace, "bulk").flushes[0]!.index),
    // The bulk's commit record is written; only the images that kept unflushed arena writes have it.
    observed: { strict: died("bulk", byArena(9, 8)), relaxed: died("bulk", byArena(9, 8)) },
  },
  {
    // Strict: the bulk returned after a full strict sync. Relaxed: it returned after the arena-only
    // amortization flush, with its metadata appends still unflushed — the kill takes the metadata flush
    // of the explicit `strictSync()` that follows.
    name: "bulk: after the flush (the commit returned)",
    locate: (trace) => at(commitPattern(trace, "bulk").window.end),
    // Relaxed: the arena-only amortization flush alone made the bulk recoverable everywhere — its
    // metadata appends (the heap's new extents) were never flushed, and redo re-extends the relation.
    observed: { strict: died("c10", every(9)), relaxed: died("strictSync", every(9)) },
  },
  {
    name: "strictSync() returned, before the next commit",
    locate: (trace) => at(windowOf(trace, "strictSync").end),
    // The power dies in c10's WAL write: nothing of c10 reached the platform.
    observed: { relaxed: died("c10", every(9)) },
  },
  {
    name: "c12 returned, before close",
    locate: (trace) => at(trace.closeStart),
    // Relaxed: c10–c12 were acknowledged and exist only in unflushed arena writes.
    observed: { strict: died("close", every(12)), relaxed: died("close", byArena(12, 9)) },
  },
];

// ── The dying run ────────────────────────────────────────────────────────────────────────────────────

interface Death {
  readonly directory: CrashOpfsDirectory;
  /** The steps that had returned before the power died: their callers saw them succeed. */
  readonly returned: readonly string[];
  /** The step the power died in (`"close"` for the orderly close after the last step). */
  readonly dying: string;
}

/**
 * Run the workload with the power set to die at `kill`. The platform's persistent state freezes there
 * and the run carries on to an orderly close against the live files (see `CrashOpfsDirectory`), so the
 * engine is released rather than leaked; the returned and dying steps are where the kill fell.
 */
async function dieAt(seed: CrashImage, durability: Durability, kill: KillAt): Promise<Death> {
  const directory = CrashOpfsDirectory.fromImage(seed);
  const pg = await openStore(directory, durability);
  directory.armKill(kill.index, kill.tornBytes);
  const returned: string[] = [];
  let dying: string | undefined;
  for (const step of STEPS) {
    await step.run(pg);
    if (directory.powerLost) dying ??= step.name;
    else returned.push(step.name);
  }
  await pg.close();
  if (!directory.powerLost) throw new Error(`the power never died at call ${kill.index}`);
  return { directory, returned, dying: dying ?? "close" };
}

// ── The reopen ───────────────────────────────────────────────────────────────────────────────────────

interface LogFrames {
  readonly frames: number;
  readonly bytes: number;
}

/**
 * The complete metadata-log frames `model`'s image holds: every append to the active metadata file
 * after its last base, among the calls before `end`, that the image kept whole. With `end` the call the
 * power died in, that append is never counted — in an image that kept it, it is torn, and recovery
 * must not replay it.
 */
function completeFramesInImage(calls: readonly CrashCall[], end: number, model: CrashImageModel): LogFrames {
  const before = calls.filter((call) => call.index < end);
  const base = last(before, (call) => call.kind === "write" && isMetadataFile(call.file) && call.offset === 0, "base");
  const activated = before.some(
    (call) => call.index > base.index && call.kind === "flush" && call.file === "activation.bin",
  );
  if (!activated) throw new Error("every kill point must follow the activation of the base its log extends");
  const appends = before.filter((call) => call.index > base.index && call.kind === "write" && call.file === base.file);
  const lastFlush = before.findLast((call) => call.kind === "flush" && call.file === base.file)?.index ?? -1;
  const keepsUnflushed = model === "applied" || model === "metadata-applied";
  const present = keepsUnflushed ? appends : appends.filter((call) => call.index < lastFlush);
  return { frames: present.length, bytes: present.reduce((sum, call) => sum + call.length, 0) };
}

interface Row {
  readonly id: number;
  readonly digest: string;
}

async function scan(pg: CrashPGlite, path: "seq" | "index"): Promise<readonly Row[]> {
  const settings =
    path === "seq"
      ? "SET enable_indexscan = off; SET enable_indexonlyscan = off; SET enable_bitmapscan = off;"
      : "SET enable_seqscan = off; SET enable_bitmapscan = off; SET enable_sort = off;";
  const query = "SELECT id, md5(payload) AS digest FROM crash_rows ORDER BY id";
  await pg.exec(settings);
  try {
    const plan = await pg.query<{ "QUERY PLAN": string }>(`EXPLAIN ${query}`);
    const planText = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(planText).toContain(path === "seq" ? "Seq Scan on crash_rows" : "Index Scan using crash_rows_pkey");
    return (await pg.query<Row>(query)).rows;
  } finally {
    await pg.exec("RESET ALL");
  }
}

/**
 * What one reopened image showed: the number of leading commits visible, or — a finding — why the store
 * or the engine would not open on it. Only the two opens are caught; every consistency assertion after
 * them fails the test outright.
 */
type Outcome = number | `unrecoverable: ${string}`;

function unrecoverable(stage: string, cause: unknown): Outcome {
  return `unrecoverable: ${stage}: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`;
}

async function reopen(image: CrashImage, durability: Durability, expectedFrames: LogFrames): Promise<Outcome> {
  // The store alone: it opens, and recovery replays exactly the complete frames the image holds.
  let vfs: RepackedVfs;
  try {
    vfs = await RepackedVfs.open(new OpfsRepackedPort(CrashOpfsDirectory.fromImage(image)));
  } catch (cause) {
    return unrecoverable("store open", cause);
  }
  const metrics = vfs.metrics();
  vfs.close();
  expect({ frames: metrics.activeLogFrames, bytes: metrics.activeLogBytes }).toEqual(expectedFrames);

  // The engine, through the factory, on an untouched copy of the same image.
  let pg: CrashPGlite;
  try {
    pg = await openStore(CrashOpfsDirectory.fromImage(image), durability);
  } catch (cause) {
    return unrecoverable("factory open", cause);
  }
  try {
    const bySeq = await scan(pg, "seq");
    const byIndex = await scan(pg, "index");
    expect(byIndex).toEqual(bySeq);
    const wrongPayloads = bySeq.filter((row) => row.digest !== digest(payloadFor(row.id))).map((row) => row.id);
    expect(wrongPayloads).toEqual([]);
    const heapProblems = await pg.query<{ problems: number }>(
      "SELECT count(*)::int AS problems FROM verify_heapam('crash_rows')",
    );
    expect(heapProblems.rows).toEqual([{ problems: 0 }]);
    await pg.query("SELECT bt_index_check('crash_rows_pkey', true)");
    const prefix = visibleCommitPrefix(bySeq.map((row) => row.id));

    // The recovered store is a working store: it takes a new commit and a checkpoint.
    await pg.query("INSERT INTO crash_rows (id, payload) VALUES ($1, $2)", [PROBE_ID, payloadFor(PROBE_ID)]);
    await pg.exec("CHECKPOINT");
    return prefix;
  } finally {
    await pg.close();
  }
}

/** Reopen every model's image; a model whose image equals an earlier one's shares its outcome. */
async function reopenEveryModel(death: Death, durability: Durability): Promise<Record<CrashImageModel, Outcome>> {
  const killed = death.directory.killedCall!;
  const calls = death.directory.calls();
  const inspected: { image: CrashImage; outcome: Outcome }[] = [];
  const outcomes = {} as Record<CrashImageModel, Outcome>;
  for (const model of MODELS) {
    const image = death.directory.image(model);
    const same = inspected.find((earlier) => sameImage(earlier.image, image));
    const outcome =
      same?.outcome ?? (await reopen(image, durability, completeFramesInImage(calls, killed.index, model)));
    if (same === undefined) inspected.push({ image, outcome });
    outcomes[model] = outcome;
  }
  return outcomes;
}

function sameImage(left: CrashImage, right: CrashImage): boolean {
  if (left.size !== right.size) return false;
  for (const [name, bytes] of left) {
    const other = right.get(name);
    if (other === undefined || !bytes.equals(other)) return false;
  }
  return true;
}

describe("opfs-repacked crash and reopen through the PGlite factory", () => {
  let seed: CrashImage;

  beforeAll(async () => {
    seed = await createSeed();
  }, TEST_TIMEOUT_MS);

  for (const durability of ["strict", "relaxed"] as const) {
    describe(`${durability} durability`, () => {
      let trace: Trace;

      beforeAll(async () => {
        trace = await traceWorkload(seed, durability);
      }, TEST_TIMEOUT_MS);

      test(`${durability}: the traced workload has the write pattern the kill points name`, () => {
        const shape = (calls: readonly CrashCall[]) =>
          calls.map((call) => (call.file === "arena.bin" ? "arena" : "metadata"));
        // The reopened seed has repacks due: one runs during the factory's boot and another in c1's host
        // sync — a strict boundary in either mode — and the orderly close runs one more. None runs in
        // between, so every kill point extends the log c1's repack activated.
        const c1 = callsIn(trace, windowOf(trace, "c1"));
        expect(c1.some((call) => call.kind === "flush" && call.file === "activation.bin")).toBe(true);
        const activations = trace.calls.filter((call) => call.kind === "write" && call.file === "activation.bin");
        expect(
          activations.filter((call) => call.index >= windowOf(trace, "c2").start && call.index < trace.closeStart),
        ).toEqual([]);

        // Each commit's WAL write precedes the append naming its extension. Strict syncs arena then
        // metadata before the query returns; relaxed flushes nothing for c5, and only the arena
        // (amortization, over 4 MiB written) for the bulk.
        const c5 = commitPattern(trace, "c5");
        const bulk = commitPattern(trace, "bulk");
        expect(c5.arenaWrite.index).toBeLessThan(c5.append.index);
        expect(bulk.arenaWrite.index).toBeLessThan(bulk.append.index);
        expect(shape(c5.flushes)).toEqual(durability === "strict" ? ["arena", "metadata"] : []);
        expect(shape(bulk.flushes)).toEqual(durability === "strict" ? ["arena", "metadata"] : ["arena"]);
        const bulkArenaBytes = callsIn(trace, bulk.window)
          .filter(isArenaWrite)
          .reduce((sum, call) => sum + call.length, 0);
        expect(bulkArenaBytes).toBeGreaterThan(4 * 1024 * 1024);
        // The explicit strictSync() finds the arena clean in both modes; relaxed still owes metadata.
        expect(shape(callsIn(trace, windowOf(trace, "strictSync")))).toEqual(
          durability === "strict" ? [] : ["metadata"],
        );
      });

      for (const point of KILL_POINTS.filter((candidate) => candidate.observed[durability] !== undefined)) {
        test(
          `${durability}: ${point.name}`,
          async () => {
            const kill = point.locate(trace, durability);
            const death = await dieAt(seed, durability, kill);

            // The power died exactly where the trace said the named operation is, and the run is the
            // traced run call for call.
            expect(death.directory.killedCall?.index).toBe(kill.index);
            expect(death.directory.calls()).toEqual(trace.calls);

            const images = await reopenEveryModel(death, durability);

            // The promise: a floor every image must meet. Strict promises every commit whose caller saw
            // it succeed before the power died; relaxed only what the last strict boundary covered.
            const floor =
              durability === "strict"
                ? commitsAmong(death.returned)
                : death.returned.includes("strictSync")
                  ? commitsBefore("strictSync")
                  : commitsAmong(death.returned.filter((step) => step === "c1"));
            const issued = commitsAmong([...death.returned, death.dying]);
            // An image the store or the engine would not open on is a finding; this names it and why.
            expect(Object.values(images).filter((outcome) => typeof outcome === "string")).toEqual([]);
            for (const model of MODELS) {
              expect(images[model] as number).toBeGreaterThanOrEqual(floor);
              expect(images[model] as number).toBeLessThanOrEqual(issued);
            }

            // Documenting, not promising: the step the power died in, and exactly what each image showed.
            expect({ dying: death.dying, images }).toEqual(point.observed[durability]!);
          },
          TEST_TIMEOUT_MS,
        );
      }

      if (durability === "strict") {
        /**
         * A transient platform failure in the WAL write of a strict commit (c6's first arena write), with
         * the platform error uncoded (a plain `Error`; a `DOMException` whose legacy code is 0, like
         * `UnknownError` and every name added after the legacy table) or coded (`QuotaExceededError`,
         * legacy code 22).
         *
         * FIXED (2026-09-25). Found by this file: the store rethrew the platform's own error on an arena
         * write that made no progress, without poisoning. PGlite maps a thrown filesystem error to an errno
         * only when it has a truthy numeric `code` (`tryFSOperation`), and its main loop
         * (`execProtocolRawSync`) swallowed every exception but its longjmp sentinel, so an uncoded error
         * unwound Postgres out of `XLogWrite` and vanished: the commit was ACKNOWLEDGED under strict
         * durability and a reopen did not have it. A coded one failed the commit (as `EFBIG` — PGlite read
         * the DOM legacy code as an errno), but the engine then spun forever on its next statement.
         *
         * The store now poisons itself on such a write and throws `StoreFailedError`, `code` EIO, whatever
         * the platform threw (README "Durability"). PGlite maps it to an I/O error, Postgres PANICs in
         * `XLogWrite` and reports it, and the commit fails; every later store call fails the same way, so
         * nothing reaches the platform after the failed write and no later host sync can acknowledge
         * anything. The PGlite side (the next statement throwing instead of spinning) is the pending test
         * below.
         */
        const PLATFORM_WRITE_FAILURES = [
          ["uncoded DOMException", () => new DOMException("transient OPFS write failure", "UnknownError")],
          ["plain Error", () => new Error("transient platform write failure")],
          ["coded DOMException", () => new DOMException("transient quota failure", "QuotaExceededError")],
        ] as const;

        /** Run c1–c5, fail c6's WAL write with `error` (thrown once, with no effect), and report what c6 did. */
        const commitSixWithFailure = async (error: unknown) => {
          const c6 = windowOf(trace, "c6");
          const walWrite = callsIn(trace, c6).find(isArenaWrite)!;
          const directory = CrashOpfsDirectory.fromImage(seed);
          const pg = await openStore(directory, "strict");
          for (const step of STEPS.slice(
            0,
            STEPS.findIndex((candidate) => candidate.name === "c6"),
          )) {
            await step.run(pg);
          }
          expect(directory.calls()).toEqual(trace.calls.slice(0, c6.start));
          directory.armTransientFailure(walWrite.index, error);
          let commitError: unknown;
          try {
            await STEPS.find((candidate) => candidate.name === "c6")!.run(pg);
          } catch (cause) {
            commitError = cause;
          }
          return { pg, directory, walWrite, commitError };
        };

        /** The engine failed the commit and the store refused to go on past the failed write. */
        const expectCommitRefused = async (
          error: unknown,
          { pg, directory, walWrite, commitError }: Awaited<ReturnType<typeof commitSixWithFailure>>,
        ) => {
          // Postgres got an I/O error for the WAL write, PANICked, and the commit rejected with it.
          expect(commitError).toBeInstanceOf(Error);
          expect((commitError as Error).message).toMatch(/could not write to log file .*: I\/O error/);
          // The store is poisoned with the platform's own error as the cause, coded EIO for the bridge.
          const poisoned = await pg.strictSync().then(
            () => undefined,
            (cause: unknown) => cause,
          );
          expect(poisoned).toBeInstanceOf(StoreFailedError);
          expect((poisoned as StoreFailedError).code).toBe(FS_ERRNO.EIO);
          expect((poisoned as StoreFailedError).cause).toBe(error);
          // Nothing reached the platform after the failed write.
          expect(directory.nextCallIndex).toBe(walWrite.index + 1);
          // Every image of what the platform holds reopens without c6.
          const applied = directory.image("applied");
          const flushed = directory.image("flushed");
          const calls = directory.calls();
          expect(await reopen(applied, "strict", completeFramesInImage(calls, calls.length, "applied"))).toBe(5);
          if (!sameImage(applied, flushed)) {
            expect(await reopen(flushed, "strict", completeFramesInImage(calls, calls.length, "flushed"))).toBe(5);
          }
        };

        test(
          "strict: a transient platform write failure in a commit's WAL write fails the commit and poisons the store",
          async () => {
            for (const [, makeError] of PLATFORM_WRITE_FAILURES) {
              const error = makeError();
              // The instance is abandoned, not closed: until the PGlite fix below ships, a statement after
              // the PANIC never returns, and close() would run the aborted engine's shutdown.
              await expectCommitRefused(error, await commitSixWithFailure(error));
            }
          },
          TEST_TIMEOUT_MS,
        );

        /**
         * PENDING the PGlite fork fix (2026-09-25): `execProtocolRawSync` fails the instance on any exception
         * that is not the Emscripten unwind/longjmp it uses for Postgres errors, so a statement after the
         * PANIC throws the failure at once instead of spinning, and `close()` releases everything without
         * running the aborted engine's shutdown. The installed `@electric-sql/pglite` (0.5.8-pgx.1) predates
         * it and spins synchronously — no test timeout can interrupt that — so this stays `test.todo` until
         * the pin moves past 0.5.8-pgx.1; then make it a `test`.
         */
        test.todo(
          "strict: after a failed WAL write the next statement throws the same failure and close releases every handle",
          async () => {
            for (const [, makeError] of PLATFORM_WRITE_FAILURES) {
              const error = makeError();
              const failed = await commitSixWithFailure(error);
              await expectCommitRefused(error, failed);
              await expect(failed.pg.query("SELECT 1")).rejects.toBe(failed.commitError);
              await expect(failed.pg.exec("SELECT 1")).rejects.toBe(failed.commitError);
              await expect(failed.pg.close()).rejects.toThrow();
              expect(failed.directory.calls().filter((call) => call.kind === "close")).toHaveLength(4);
            }
          },
          TEST_TIMEOUT_MS,
        );
      }
    });
  }
});
