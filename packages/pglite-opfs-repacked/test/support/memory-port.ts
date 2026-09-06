/**
 * `MemoryRepackedPort` now ships as package source (`src/core/memory-port.ts`) because the sync broker
 * needs an engine-agnostic port off the main thread. This module stays as the test-support import path
 * so no second copy exists.
 */
export {
  MemoryRepackedPort,
  type MemoryEffectSummary,
  type MemoryFault,
  type MemoryOperation,
  type MemoryOperationSummary,
  type TerminationDecision,
} from "../../src/core/memory-port";
