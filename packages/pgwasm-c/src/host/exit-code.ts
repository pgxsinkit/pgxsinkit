/**
 * Emscripten's runtime writes an exit status onto the host's `process.exitCode` when the program
 * exits, and Postgres' single-user mode reports a successful start by exiting with 99. Under Bun that
 * sentinel would survive to the end of the process and fail an otherwise green run. Every glue call that
 * can exit is wrapped so the host's own exit code is left as it was.
 */

interface ProcessWithExitCode {
  exitCode?: number | string | undefined;
}

function hostProcess(): ProcessWithExitCode | undefined {
  return (globalThis as { process?: ProcessWithExitCode }).process;
}

/**
 * Run `fn`, restoring `process.exitCode` (where there is a process) to its value before. Bun ignores an
 * assignment of `undefined`, so an exit code that was unset is restored as 0 — only when `fn` changed it.
 */
export function preservingExitCode<T>(fn: () => T): T {
  const proc = hostProcess();
  if (proc === undefined) return fn();
  const before = proc.exitCode;
  try {
    return fn();
  } finally {
    if (proc.exitCode !== before) proc.exitCode = before ?? 0;
  }
}
