import { describe, expect, test } from "bun:test";

import { FsError, StoreFailedError } from "../../packages/pglite-opfs-repacked/src/core/errors";
import { RepackedVfs } from "../../packages/pglite-opfs-repacked/src/core/repacked-vfs";
import { MemoryRepackedPort } from "../../packages/pglite-opfs-repacked/test/support/memory-port";
import type {
  MemoryEffectSummary,
  MemoryFault,
  MemoryOperationSummary,
  TerminationDecision,
} from "../../packages/pglite-opfs-repacked/test/support/memory-port";

const EXTENT_SIZES = [8192, 65_536] as const;
const STABLE_BYTES = new Uint8Array(257).fill(0x11);

interface OperationOccurrence extends MemoryOperationSummary {
  readonly file: NonNullable<MemoryOperationSummary["file"]>;
  readonly operation: "write" | "truncate" | "flush";
  readonly occurrence: number;
}

interface FaultVariant {
  readonly name: string;
  readonly outcome: MemoryFault["outcome"];
  readonly bytes?: number;
}

interface TerminationVariant {
  readonly name: string;
  readonly decisions: (effects: readonly MemoryEffectSummary[]) => Readonly<Record<number, TerminationDecision>>;
}

interface RandomCommand {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const TERMINATIONS: readonly TerminationVariant[] = [
  { name: "all-absent", decisions: () => ({}) },
  { name: "all-full", decisions: (effects) => decide(effects, () => "full") },
  {
    name: "arena-only",
    decisions: (effects) => decide(effects, (effect) => (effect.file === "arena.bin" ? "full" : "absent")),
  },
  {
    name: "metadata-only",
    decisions: (effects) => decide(effects, (effect) => (effect.file === "arena.bin" ? "absent" : "full")),
  },
  {
    name: "partial-writes",
    decisions: (effects) =>
      decide(effects, (effect) => (effect.operation === "truncate" ? "full" : Math.floor(effect.bytes / 2))),
  },
];

function decide(
  effects: readonly MemoryEffectSummary[],
  choice: (effect: MemoryEffectSummary) => TerminationDecision,
): Readonly<Record<number, TerminationDecision>> {
  return Object.fromEntries(effects.map((effect) => [effect.id, choice(effect)]));
}

function faultVariants(operation: OperationOccurrence["operation"]): readonly FaultVariant[] {
  if (operation === "write") {
    return [
      { name: "short", outcome: "short", bytes: 1 },
      { name: "throw-before", outcome: "throw-before" },
      { name: "partial-then-error", outcome: "throw-after", bytes: 1 },
      { name: "full-then-error", outcome: "throw-after" },
    ];
  }
  return [
    { name: "throw-before", outcome: "throw-before" },
    { name: "full-then-error", outcome: "throw-after" },
  ];
}

function persistentOccurrences(operations: readonly MemoryOperationSummary[]): readonly OperationOccurrence[] {
  const counts = new Map<string, number>();
  const occurrences: OperationOccurrence[] = [];
  for (const operation of operations) {
    if (
      operation.file === undefined ||
      (operation.operation !== "write" && operation.operation !== "truncate" && operation.operation !== "flush")
    ) {
      continue;
    }
    const key = `${operation.operation}:${operation.file}:${operation.label}`;
    const occurrence = counts.get(key) ?? 0;
    counts.set(key, occurrence + 1);
    occurrences.push({ ...operation, operation: operation.operation, file: operation.file, occurrence });
  }
  return occurrences;
}

async function seedOrdinaryScenario(extentSize: number): Promise<{
  port: MemoryRepackedPort;
  vfs: RepackedVfs;
  candidateBytes: Uint8Array;
  oldBytes: Uint8Array;
}> {
  const port = new MemoryRepackedPort();
  const vfs = await RepackedVfs.open(port, { extentSize });
  const oldBytes = new Uint8Array(extentSize).fill(0x7a);
  const candidateBytes = new Uint8Array(extentSize + 17).fill(0x42);
  vfs.writeFile("/stable", STABLE_BYTES, { nowMs: 1n });
  vfs.writeFile("/old", oldBytes, { nowMs: 2n });
  vfs.strictSync();
  port.clearObservedOperations();
  return { port, vfs, candidateBytes, oldBytes };
}

function runOrdinaryOperation(vfs: RepackedVfs, candidateBytes: Uint8Array): void {
  vfs.unlink("/old", 3n);
  vfs.writeFile("/candidate", candidateBytes, { nowMs: 4n });
  vfs.strictSync();
}

async function discoverOrdinaryOccurrences(extentSize: number): Promise<readonly OperationOccurrence[]> {
  const { port, vfs, candidateBytes } = await seedOrdinaryScenario(extentSize);
  runOrdinaryOperation(vfs, candidateBytes);
  const occurrences = persistentOccurrences(port.observedOperations());
  port.terminate();
  return occurrences;
}

async function runOrdinaryFaultCase(
  extentSize: number,
  occurrence: OperationOccurrence,
  variant: FaultVariant,
  termination: TerminationVariant,
): Promise<void> {
  const { port, vfs, candidateBytes, oldBytes } = await seedOrdinaryScenario(extentSize);
  port.injectFault({
    operation: occurrence.operation,
    file: occurrence.file,
    label: occurrence.label,
    occurrence: occurrence.occurrence,
    outcome: variant.outcome,
    ...(variant.bytes === undefined ? {} : { bytes: variant.bytes }),
  });

  let liveError: unknown;
  try {
    runOrdinaryOperation(vfs, candidateBytes);
  } catch (cause) {
    liveError = cause;
  }
  if (
    liveError !== undefined &&
    variant.outcome !== "short" &&
    (occurrence.label === "txn.append" || occurrence.label.startsWith("sync."))
  ) {
    expect(() => vfs.readdir("/")).toThrow(StoreFailedError);
  }

  port.terminate(termination.decisions(port.pendingEffects()));
  const reopened = await RepackedVfs.open(port);
  expect(reopened.readFile("/stable")).toEqual(STABLE_BYTES);
  const old = readIfPresent(reopened, "/old");
  const candidate = readIfPresent(reopened, "/candidate");
  if (old !== undefined) expect(old).toEqual(oldBytes);
  if (candidate !== undefined) {
    expect(candidate.byteLength).toBeLessThanOrEqual(candidateBytes.byteLength);
    expect(candidate.every((byte) => byte === 0 || byte === 0x42)).toBe(true);
  }
  if (old !== undefined && candidate !== undefined) {
    reopened.writeFile("/candidate", new Uint8Array(candidate.byteLength).fill(0x24), { nowMs: 5n });
    expect(reopened.readFile("/old")).toEqual(oldBytes);
  }
  assertAllocatorCounts(reopened);
  reopened.close();
}

async function seedRepackScenario(extentSize: number): Promise<{
  port: MemoryRepackedPort;
  vfs: RepackedVfs;
}> {
  const port = new MemoryRepackedPort();
  const vfs = await RepackedVfs.open(port, { extentSize });
  vfs.writeFile("/stable", STABLE_BYTES, { nowMs: 1n });
  vfs.writeFile("/old", new Uint8Array(extentSize).fill(0x7a), { nowMs: 2n });
  vfs.strictSync();
  vfs.unlink("/old", 3n);
  vfs.strictSync();
  vfs.repack();
  port.clearObservedOperations();
  return { port, vfs };
}

async function discoverRepackOccurrences(extentSize: number): Promise<readonly OperationOccurrence[]> {
  const { port, vfs } = await seedRepackScenario(extentSize);
  vfs.repack();
  const occurrences = persistentOccurrences(port.observedOperations());
  port.terminate();
  return occurrences;
}

async function runRepackFaultCase(
  extentSize: number,
  occurrence: OperationOccurrence,
  variant: FaultVariant,
  termination: TerminationVariant,
): Promise<void> {
  const { port, vfs } = await seedRepackScenario(extentSize);
  port.injectFault({
    operation: occurrence.operation,
    file: occurrence.file,
    label: occurrence.label,
    occurrence: occurrence.occurrence,
    outcome: variant.outcome,
    ...(variant.bytes === undefined ? {} : { bytes: variant.bytes }),
  });

  let liveError: unknown;
  try {
    vfs.repack();
  } catch (cause) {
    liveError = cause;
  }
  if (liveError !== undefined && occurrence.label.startsWith("repack.activation.")) {
    expect(() => vfs.readdir("/")).toThrow(StoreFailedError);
  } else if (liveError !== undefined) {
    expect(vfs.readdir("/")).toContain("stable");
  }

  port.terminate(termination.decisions(port.pendingEffects()));
  const reopened = await RepackedVfs.open(port);
  expect(reopened.readFile("/stable")).toEqual(STABLE_BYTES);
  expect(readIfPresent(reopened, "/old")).toBeUndefined();
  expect([2n, 3n]).toContain(reopened.metrics().generation);
  assertAllocatorCounts(reopened);
  reopened.writeFile("/replacement", Uint8Array.of(0x33), { nowMs: 4n });
  expect(reopened.readFile("/stable")).toEqual(STABLE_BYTES);
  reopened.close();
}

function readIfPresent(vfs: RepackedVfs, path: string): Uint8Array | undefined {
  try {
    return vfs.readFile(path);
  } catch (cause) {
    if (cause instanceof FsError && cause.code === 44) return undefined;
    throw cause;
  }
}

function assertAllocatorCounts(vfs: RepackedVfs): void {
  const metrics = vfs.metrics();
  expect(BigInt(metrics.availableExtents + metrics.quarantineExtents)).toBeLessThanOrEqual(metrics.totalExtents);
}

async function withCaseContext(context: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (cause) {
    throw new Error(`generated fault case failed: ${context}`, { cause });
  }
}

function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

function randomCommands(seed: number, extentSize: number): readonly RandomCommand[] {
  const random = randomSource(seed);
  return Array.from({ length: 8 }, (_, index) => {
    const length = 1 + (random() % (extentSize + 32));
    return {
      path: `/random-${index.toString().padStart(2, "0")}`,
      bytes: new Uint8Array(length).fill(0x30 + index),
    };
  });
}

async function randomScenarioOccurrences(
  extentSize: number,
  commands: readonly RandomCommand[],
  durability: "relaxed" | "strict",
): Promise<readonly OperationOccurrence[]> {
  const port = new MemoryRepackedPort();
  const vfs = await RepackedVfs.open(port, { extentSize });
  vfs.writeFile("/stable", STABLE_BYTES, { nowMs: 1n });
  vfs.strictSync();
  port.clearObservedOperations();
  for (const [index, command] of commands.entries()) {
    vfs.writeFile(command.path, command.bytes, { nowMs: BigInt(index + 2) });
    if (durability === "strict") vfs.strictSync();
  }
  const occurrences = persistentOccurrences(port.observedOperations());
  port.terminate();
  return occurrences;
}

async function runRandomCrashFaultCase(
  seed: number,
  extentSize: number,
  durability: "relaxed" | "strict",
): Promise<void> {
  const random = randomSource(seed ^ extentSize ^ (durability === "strict" ? 0x5a5a_5a5a : 0xa5a5_a5a5));
  const commands = randomCommands(seed, extentSize);
  const occurrences = await randomScenarioOccurrences(extentSize, commands, durability);
  const occurrence = occurrences[random() % occurrences.length]!;
  const variants = faultVariants(occurrence.operation);
  const variant = variants[random() % variants.length]!;

  const port = new MemoryRepackedPort();
  const vfs = await RepackedVfs.open(port, { extentSize });
  vfs.writeFile("/stable", STABLE_BYTES, { nowMs: 1n });
  vfs.strictSync();
  port.clearObservedOperations();
  port.injectFault({
    operation: occurrence.operation,
    file: occurrence.file,
    label: occurrence.label,
    occurrence: occurrence.occurrence,
    outcome: variant.outcome,
    ...(variant.bytes === undefined ? {} : { bytes: variant.bytes }),
  });

  let attempted = 0;
  let strictAcknowledged = 0;
  for (const [index, command] of commands.entries()) {
    attempted += 1;
    try {
      vfs.writeFile(command.path, command.bytes, { nowMs: BigInt(index + 2) });
      if (durability === "strict") vfs.strictSync();
      strictAcknowledged += durability === "strict" ? 1 : 0;
    } catch {
      break;
    }
  }

  const decisions: Record<number, TerminationDecision> = {};
  for (const effect of port.pendingEffects()) {
    if (effect.operation === "truncate") {
      decisions[effect.id] = random() % 2 === 0 ? "absent" : "full";
    } else {
      const choice = random() % 3;
      decisions[effect.id] = choice === 0 ? "absent" : choice === 1 ? "full" : random() % (effect.bytes + 1);
    }
  }
  port.terminate(decisions);

  const reopened = await RepackedVfs.open(port);
  expect(reopened.readFile("/stable")).toEqual(STABLE_BYTES);
  const recoveredRandomPaths = reopened.readdir("/").filter((path) => path.startsWith("random-"));
  const recoveredCount = recoveredRandomPaths.length;
  expect(recoveredCount).toBeLessThanOrEqual(attempted);
  if (durability === "strict") expect(recoveredCount).toBeGreaterThanOrEqual(strictAcknowledged);
  expect(recoveredRandomPaths).toEqual(commands.slice(0, recoveredCount).map((command) => command.path.slice(1)));
  for (let index = 0; index < recoveredCount; index += 1) {
    const recovered = reopened.readFile(commands[index]!.path);
    const expected = commands[index]!.bytes;
    expect(recovered.byteLength).toBeLessThanOrEqual(expected.byteLength);
    if (durability === "strict" && index < strictAcknowledged) {
      expect(recovered).toEqual(expected);
    } else {
      expect(recovered.every((byte, byteIndex) => byte === 0 || byte === expected[byteIndex])).toBe(true);
    }
  }
  assertAllocatorCounts(reopened);
  reopened.close();
}

const FD_TARGET_PATHS = ["/fd-a", "/fd-b"] as const;
const FD_ORPHAN_PATH = "/fd-orphan";
const FD_ORPHAN_STEP = 4;
const FD_ORPHAN_CHUNK = new Uint8Array(97).fill(0x66);

interface FdRandomStep {
  readonly target: 0 | 1;
  readonly chunk: Uint8Array;
}

function randomFdSteps(seed: number, extentSize: number): readonly FdRandomStep[] {
  const random = randomSource(seed ^ 0x0f0f_0f0f);
  return Array.from({ length: 10 }, (_, index) => ({
    target: (random() % 2) as 0 | 1,
    chunk: new Uint8Array(1 + (random() % Math.min(extentSize + 32, 4096))).fill(0x40 + index),
  }));
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left, 0);
  joined.set(right, left.byteLength);
  return joined;
}

interface FdScenarioOutcome {
  written: [Uint8Array, Uint8Array];
  acknowledged: [number, number];
}

/**
 * Sequential fd appends interleaved across two files, composed with an
 * open-descriptor unlink. Same-file consecutive appends exercise pending
 * resize replacement; target switches, strict syncs, and awaited relaxed
 * boundaries exercise materialization; the crash window can therefore close
 * on an unmaterialized coalesced tail.
 */
function runFdScenario(vfs: RepackedVfs, steps: readonly FdRandomStep[], durability: "relaxed" | "strict") {
  const outcome: FdScenarioOutcome = {
    written: [new Uint8Array(), new Uint8Array()],
    acknowledged: [0, 0],
  };
  try {
    const fds = [
      vfs.open(FD_TARGET_PATHS[0], "w+", 0o100600, 1n),
      vfs.open(FD_TARGET_PATHS[1], "w+", 0o100600, 1n),
    ] as const;
    const orphanFd = vfs.open(FD_ORPHAN_PATH, "w+", 0o100600, 1n);
    for (const [index, step] of steps.entries()) {
      const nowMs = BigInt(index + 2);
      if (index === FD_ORPHAN_STEP) {
        vfs.write(orphanFd, FD_ORPHAN_CHUNK, 0, FD_ORPHAN_CHUNK.byteLength, undefined, nowMs);
        vfs.unlink(FD_ORPHAN_PATH, nowMs);
        vfs.write(orphanFd, FD_ORPHAN_CHUNK, 0, FD_ORPHAN_CHUNK.byteLength, undefined, nowMs);
      }
      const count = vfs.write(fds[step.target], step.chunk, 0, step.chunk.byteLength, undefined, nowMs);
      outcome.written[step.target] = appendBytes(outcome.written[step.target], step.chunk.subarray(0, count));
      if (durability === "strict") {
        vfs.strictSync();
        outcome.acknowledged = [outcome.written[0].byteLength, outcome.written[1].byteLength];
      } else if (index % 3 === 2) {
        // The awaited relaxed host boundary: materializes any pending tail.
        vfs.runScheduledRepack();
      }
    }
  } catch {
    // A generated fault ends the stream; the recovery oracle judges the rest.
  }
  return outcome;
}

async function discoverFdOccurrences(
  seed: number,
  extentSize: number,
  durability: "relaxed" | "strict",
): Promise<readonly OperationOccurrence[]> {
  const port = new MemoryRepackedPort();
  const vfs = await RepackedVfs.open(port, { extentSize });
  vfs.writeFile("/stable", STABLE_BYTES, { nowMs: 1n });
  vfs.strictSync();
  port.clearObservedOperations();
  runFdScenario(vfs, randomFdSteps(seed, extentSize), durability);
  const occurrences = persistentOccurrences(port.observedOperations());
  port.terminate();
  return occurrences;
}

async function runFdCrashFaultCase(seed: number, extentSize: number, durability: "relaxed" | "strict"): Promise<void> {
  const random = randomSource(seed ^ extentSize ^ (durability === "strict" ? 0x3c3c_3c3c : 0xc3c3_c3c3));
  const steps = randomFdSteps(seed, extentSize);
  const occurrences = await discoverFdOccurrences(seed, extentSize, durability);
  const occurrence = occurrences[random() % occurrences.length]!;
  const variants = faultVariants(occurrence.operation);
  const variant = variants[random() % variants.length]!;

  const port = new MemoryRepackedPort();
  const vfs = await RepackedVfs.open(port, { extentSize });
  vfs.writeFile("/stable", STABLE_BYTES, { nowMs: 1n });
  vfs.strictSync();
  port.clearObservedOperations();
  port.injectFault({
    operation: occurrence.operation,
    file: occurrence.file,
    label: occurrence.label,
    occurrence: occurrence.occurrence,
    outcome: variant.outcome,
    ...(variant.bytes === undefined ? {} : { bytes: variant.bytes }),
  });
  const outcome = runFdScenario(vfs, steps, durability);

  const decisions: Record<number, TerminationDecision> = {};
  for (const effect of port.pendingEffects()) {
    if (effect.operation === "truncate") {
      decisions[effect.id] = random() % 2 === 0 ? "absent" : "full";
    } else {
      const choice = random() % 3;
      decisions[effect.id] = choice === 0 ? "absent" : choice === 1 ? "full" : random() % (effect.bytes + 1);
    }
  }
  port.terminate(decisions);

  const reopened = await RepackedVfs.open(port);
  expect(reopened.readFile("/stable")).toEqual(STABLE_BYTES);
  for (const [target, path] of FD_TARGET_PATHS.entries()) {
    const recovered = readIfPresent(reopened, path);
    const written = outcome.written[target as 0 | 1];
    const acknowledged = outcome.acknowledged[target as 0 | 1];
    if (recovered === undefined) {
      expect(acknowledged).toBe(0);
      continue;
    }
    expect(recovered.byteLength).toBeLessThanOrEqual(written.byteLength);
    expect(recovered.byteLength).toBeGreaterThanOrEqual(acknowledged);
    for (let index = 0; index < recovered.byteLength; index += 1) {
      const byte = recovered[index]!;
      if (index < acknowledged) {
        expect(byte).toBe(written[index]!);
      } else if (byte !== 0 && byte !== written[index]!) {
        throw new Error(`recovered byte ${index} of ${path} is neither written data nor zero`);
      }
    }
  }
  const orphanRecovered = readIfPresent(reopened, FD_ORPHAN_PATH);
  if (orphanRecovered !== undefined) {
    // The unlink frame was lost; only the pre-unlink write can be visible.
    expect(orphanRecovered.byteLength).toBeLessThanOrEqual(FD_ORPHAN_CHUNK.byteLength);
    for (let index = 0; index < orphanRecovered.byteLength; index += 1) {
      const byte = orphanRecovered[index]!;
      if (byte !== 0 && byte !== FD_ORPHAN_CHUNK[index]!) {
        throw new Error(`recovered orphan byte ${index} is neither written data nor zero`);
      }
    }
  }
  assertAllocatorCounts(reopened);
  reopened.writeFile("/post-crash", Uint8Array.of(0x55), { nowMs: 99n });
  expect(reopened.readFile("/post-crash")).toEqual(Uint8Array.of(0x55));
  reopened.close();
}

describe("opfs-repacked generated labeled-effect crash campaign", () => {
  test("strict acknowledged composed operations survive termination at both extent profiles", async () => {
    for (const extentSize of EXTENT_SIZES) {
      const { port, vfs, candidateBytes } = await seedOrdinaryScenario(extentSize);
      runOrdinaryOperation(vfs, candidateBytes);
      port.terminate();
      const reopened = await RepackedVfs.open(port);
      expect(reopened.readFile("/stable")).toEqual(STABLE_BYTES);
      expect(readIfPresent(reopened, "/old")).toBeUndefined();
      expect(reopened.readFile("/candidate")).toEqual(candidateBytes);
      assertAllocatorCounts(reopened);
      reopened.close();
    }
  });

  test("ordinary mutations recover a valid prefix after every generated labeled persistence fault", async () => {
    for (const extentSize of EXTENT_SIZES) {
      const occurrences = await discoverOrdinaryOccurrences(extentSize);
      expect(occurrences.length).toBeGreaterThan(0);
      for (const occurrence of occurrences) {
        for (const variant of faultVariants(occurrence.operation)) {
          for (const termination of TERMINATIONS) {
            const context = `${extentSize}:${occurrence.operation}:${occurrence.file}:${occurrence.label}[${occurrence.occurrence}]:${variant.name}:${termination.name}`;
            await withCaseContext(context, () => runOrdinaryFaultCase(extentSize, occurrence, variant, termination));
          }
        }
      }
    }
  });

  test("repack recovers one exact authority after every generated labeled persistence fault", async () => {
    for (const extentSize of EXTENT_SIZES) {
      const occurrences = await discoverRepackOccurrences(extentSize);
      expect(occurrences.length).toBeGreaterThan(0);
      for (const occurrence of occurrences) {
        for (const variant of faultVariants(occurrence.operation)) {
          for (const termination of TERMINATIONS) {
            const context = `${extentSize}:${occurrence.operation}:${occurrence.file}:${occurrence.label}[${occurrence.occurrence}]:${variant.name}:${termination.name}`;
            await withCaseContext(context, () => runRepackFaultCase(extentSize, occurrence, variant, termination));
          }
        }
      }
    }
  });

  test("seeded random command and crash-fault sequences satisfy strict and relaxed recovery oracles", async () => {
    for (const extentSize of EXTENT_SIZES) {
      for (const durability of ["relaxed", "strict"] as const) {
        for (let seed = 1; seed <= 20; seed += 1) {
          await withCaseContext(`random:${seed}:${extentSize}:${durability}`, () =>
            runRandomCrashFaultCase(seed, extentSize, durability),
          );
        }
      }
    }
  });

  test("seeded random fd-append and crash-fault sequences satisfy the coalesced-resize recovery oracles", async () => {
    for (const extentSize of EXTENT_SIZES) {
      for (const durability of ["relaxed", "strict"] as const) {
        for (let seed = 1; seed <= 20; seed += 1) {
          await withCaseContext(`fd-random:${seed}:${extentSize}:${durability}`, () =>
            runFdCrashFaultCase(seed, extentSize, durability),
          );
        }
      }
    }
  });
});
