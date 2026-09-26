import type { PostgresModule } from "../emscripten";

/**
 * How the C build mounts one kind of storage over the data directory. The lifecycle follows the boot:
 * `acquire` before the module exists, `preRun` inside its instantiation, `initialSync` once mounted,
 * `persist` after statements, then `close` (a normal close) or `cleanupFailedInit` (a failed boot).
 */
export interface StorageMount {
  acquire(): Promise<void>;
  readonly preRun: ((module: PostgresModule) => void) | undefined;
  initialSync(module: PostgresModule): Promise<void>;
  persist(module: PostgresModule, relaxed: boolean): Promise<void>;
  close(module: PostgresModule | undefined): Promise<void>;
  cleanupFailedInit(module: PostgresModule | undefined): Promise<void>;
}
