// Deploy the board demo to managed BaaS — Supabase Cloud + Electric Cloud (board ADR-0008).
//
// Wraps the REPEATABLE steps a developer runs after the one-time manual setup in the runbook
// (docs/runbooks/board-on-cloud.md): create the project, create the Electric Cloud source on its
// database, and `supabase login`. Reads credentials from `board.cloud.env` (gitignored;
// copy from board.cloud.env.example). Each step is also a separate `board:cloud:*` script so you can
// re-run just one.
//
//   bun run board:cloud:deploy      # migrate → secrets → functions → seed (the whole repeatable path)
//   bun run board:cloud:reset       # purge → migrate → seed (rebuild the cloud DB from the committed
//                                   # history — same as the nightly Demo reset action; run after a
//                                   # migration-history rewrite, plus board:cloud:functions if server
//                                   # code changed)
//   bun run board:cloud:migrate     # apply the board's migrations to the cloud DB (direct connection)
//   bun run board:cloud:secrets     # set the function secrets the platform does NOT auto-provide
//   bun run board:cloud:functions   # build the bundles + `supabase functions deploy`
//   bun run board:cloud:seed        # GoTrue identities + fixtures against the cloud project
//   bun run board:cloud:dev         # launch the local Vite client against the cloud backend
//   bun run board:cloud:preview     # build + serve the compiled client against the cloud backend
//
// What the platform provides vs. what we set: Supabase Cloud auto-injects SUPABASE_URL (→ JWKS) and
// SUPABASE_DB_URL (the pooler → board-write) into every function, and the `SUPABASE_` prefix is
// RESERVED (the CLI rejects secrets with it). So the only function secret to set is ELECTRIC_SHAPE_URL
// (board-sync's upstream, with the Cloud source_id+secret). BOARD_ALLOWED_ORIGINS defaults to the
// local Vite origin, which is what the frontend uses against the cloud backend, so it needs no secret.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ENV_FILE = "board.cloud.env";

// The Supabase CLI binary. Override with SUPABASE_BIN (e.g. an absolute path) if it isn't a plain
// `supabase` on PATH — a mise/asdf shim or a non-login-shell PATH gap won't be visible to this
// spawned process.
const SUPABASE_BIN = process.env["SUPABASE_BIN"] ?? "supabase";

type Step = "deploy" | "purge" | "migrate" | "secrets" | "functions" | "seed";
const STEPS: readonly Step[] = ["migrate", "secrets", "functions", "seed"];
// `reset` = what the Demo reset workflow (.github/workflows/demo-reset.yml) runs nightly, from the CL:
// drop every migration-created board object, re-apply the latest committed history, reseed. The way to
// ship a rewritten/collapsed migration history (docs/runbooks/regenerate-migrations.md) to the cloud
// project. Function bundles are the separate `functions` step.
const RESET_STEPS: readonly Step[] = ["purge", "migrate", "seed"];

// BOARD_PUBLISHABLE_KEY is required too: the deploy steps don't use it (seed uses the secret key), so
// leaving it as the placeholder still lets `deploy` pass — but the browser sends it as `apikey`, and a
// placeholder there is exactly the "Invalid API key" sign-in failure. Validating it up front turns that
// runtime mystery into a clear startup error.
const REQUIRED = [
  "BOARD_SUPABASE_PROJECT_REF",
  "BOARD_SUPABASE_ACCESS_TOKEN",
  "BOARD_PUBLISHABLE_KEY",
  "BOARD_SECRET_KEY",
  "BOARD_DATABASE_URL",
  "ELECTRIC_SHAPE_URL",
] as const;

// Sentinels from board.cloud.env.example — a value still carrying one means the field wasn't filled in.
const PLACEHOLDER_MARKERS = ["YOUR_", "xxxxxxxx", "<id>", "<secret>", "<ref>"];

export interface BoardSupabaseProject {
  ref: string;
  url: string;
}

export function boardSupabaseProject(env: Record<string, string>): BoardSupabaseProject {
  const ref = env["BOARD_SUPABASE_PROJECT_REF"];
  if (!ref || PLACEHOLDER_MARKERS.some((marker) => ref.includes(marker))) {
    throw new Error(`${ENV_FILE} needs a real BOARD_SUPABASE_PROJECT_REF.`);
  }
  if (!/^[a-z0-9]{20}$/.test(ref)) {
    throw new Error(`${ENV_FILE} BOARD_SUPABASE_PROJECT_REF must be the 20-character lowercase project ref.`);
  }

  const url = env["BOARD_SUPABASE_URL"] || `https://${ref}.supabase.co`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${ENV_FILE} BOARD_SUPABASE_URL must be a valid URL.`);
  }
  const standardHost = parsed.hostname.match(/^([a-z0-9]{20})\.supabase\.co$/);
  if (standardHost && standardHost[1] !== ref) {
    throw new Error(`${ENV_FILE} BOARD_SUPABASE_URL does not match BOARD_SUPABASE_PROJECT_REF (${ref}).`);
  }

  return { ref, url };
}

export function boardSupabaseSecretsArgs(env: Record<string, string>, file: string): string[] {
  return ["secrets", "set", "--project-ref", boardSupabaseProject(env).ref, "--env-file", file];
}

export function boardSupabaseFunctionsArgs(env: Record<string, string>): string[] {
  return ["functions", "deploy", "--project-ref", boardSupabaseProject(env).ref, "board-write", "board-sync"];
}

export function boardSupabaseCliEnv(env: Record<string, string>): Record<string, string> {
  const token = env["BOARD_SUPABASE_ACCESS_TOKEN"];
  if (!token || PLACEHOLDER_MARKERS.some((marker) => token.includes(marker))) {
    throw new Error(`${ENV_FILE} needs a real BOARD_SUPABASE_ACCESS_TOKEN.`);
  }
  return { SUPABASE_ACCESS_TOKEN: token };
}

function loadCloudEnv(): Record<string, string> {
  const file = path.resolve(process.cwd(), ENV_FILE);
  if (!existsSync(file)) {
    throw new Error(
      `${ENV_FILE} not found. Copy board.cloud.env.example to ${ENV_FILE} and fill in your project's values.`,
    );
  }
  const env: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    // Strip surrounding quotes — a quoted `sb_publishable_…` would carry the quotes into the apikey.
    env[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
  }
  const missing = REQUIRED.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`${ENV_FILE} is missing required values: ${missing.join(", ")}`);
  }
  const unfilled = REQUIRED.filter((key) => PLACEHOLDER_MARKERS.some((marker) => env[key]!.includes(marker)));
  if (unfilled.length > 0) {
    throw new Error(
      `${ENV_FILE} still has placeholder values for: ${unfilled.join(", ")}. ` +
        "Replace them with your real project values (Project Settings → API Keys / Database).",
    );
  }
  env["BOARD_SUPABASE_URL"] = boardSupabaseProject(env).url;
  return env;
}

function run(command: string, args: string[], extraEnv: Record<string, string> = {}): void {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
  // A spawn failure (the binary wasn't found / couldn't start) sets `error` and leaves `status`
  // null/undefined — distinguish it from a command that ran and exited non-zero, which is the
  // difference between "supabase isn't on PATH" and "supabase reported an error".
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `\`${command}\` was not found on PATH. Install it and make sure it is a real binary visible to ` +
          `non-interactive shells (a shell alias/function is not enough). See docs/runbooks/board-on-cloud.md.`,
      );
    }
    throw new Error(`Failed to start \`${command}\`: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Command failed (exit ${result.status ?? "killed"}): ${command} ${args.join(" ")}`);
  }
}

// The secrets + functions steps shell out to the Supabase CLI; fail early with a clear message if it
// isn't runnable, rather than deep inside a step.
function requireSupabaseCli(): void {
  const probe = spawnSync(SUPABASE_BIN, ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    throw new Error(
      `The Supabase CLI (\`${SUPABASE_BIN}\`) is required for the secrets + functions steps but is not ` +
        "runnable. Install it (https://supabase.com/docs/guides/cli), then configure " +
        "BOARD_SUPABASE_ACCESS_TOKEN. " +
        "If it lives off PATH, set SUPABASE_BIN to its absolute " +
        "path. See docs/runbooks/board-on-cloud.md.",
    );
  }
}

// Apply the board's migrations to the cloud Postgres over the DIRECT connection (DDL + the
// SECURITY DEFINER membership helper + the apply function need the privileged `postgres` role).
function migrate(env: Record<string, string>): void {
  run("bun", ["run", "db:board:migrate"], { BOARD_DATABASE_URL: env["BOARD_DATABASE_URL"]! });
}

// Set ONLY the non-reserved, non-auto function secret: board-sync's Electric Cloud upstream. Via a
// temp env file, not inline `KEY=VALUE` argv — the Electric URL carries `?`/`&`/`=`, and an env file
// reads the whole value verbatim (no CLI arg-splitting) AND keeps the source secret out of the process
// list. The file is written 0600 under tmp/ and removed even on failure.
function secrets(env: Record<string, string>): void {
  const dir = "tmp/agents";
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "board-cloud-secret.env");
  const lines = [`ELECTRIC_SHAPE_URL=${env["ELECTRIC_SHAPE_URL"]}`];
  // Optional: the CORS allow-list both functions read (board-sync + board-write). Needed when the
  // frontend is hosted at a real origin (e.g. a GitHub Pages /demo) rather than localhost. The
  // functions default to localhost dev origins, so it can be left unset for `board:cloud:dev`.
  if (env["BOARD_ALLOWED_ORIGINS"]) {
    lines.push(`BOARD_ALLOWED_ORIGINS=${env["BOARD_ALLOWED_ORIGINS"]}`);
  }
  try {
    writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
    run(SUPABASE_BIN, boardSupabaseSecretsArgs(env, file), boardSupabaseCliEnv(env));
  } finally {
    rmSync(file, { force: true });
  }
}

// Build the self-contained bundles, then deploy them (config.toml points each function's entrypoint at
// its functions-dist/<name>/index.js with verify_jwt=false).
function functions(env: Record<string, string>): void {
  run("bun", ["run", "edge:build"]);
  run(SUPABASE_BIN, boardSupabaseFunctionsArgs(env), boardSupabaseCliEnv(env));
}

// Drop every migration-created board object (model-derived list; scripts/board-purge.ts) so `migrate`
// re-applies the committed history from an empty ledger.
function purge(env: Record<string, string>): void {
  run("bun", ["run", "purge:board"], { BOARD_DATABASE_URL: env["BOARD_DATABASE_URL"]! });
}

// Seed identities (GoTrue admin API via the project gateway, which translates the secret key) + the
// deterministic public fixtures (direct DB connection, BYPASSRLS as `postgres`).
function seed(env: Record<string, string>): void {
  run("bun", ["run", "seed:board"], {
    BOARD_GATEWAY_URL: env["BOARD_SUPABASE_URL"]!,
    BOARD_SECRET_KEY: env["BOARD_SECRET_KEY"]!,
    BOARD_DATABASE_URL: env["BOARD_DATABASE_URL"]!,
  });
}

// Launch the local Vite client against the cloud backend. Vite exposes `process.env` vars matching its
// `VITE_` prefix to `import.meta.env`, so the frontend values are derived from board.cloud.env and
// passed straight through — no `.env` edit. Only VITE_-prefixed vars reach the browser, so this hands
// over the PUBLISHABLE key (safe to expose), never the secret.
function dev(env: Record<string, string>): void {
  const browserEnv = boardFrontendCloudEnv(env);
  const url = browserEnv["VITE_BOARD_SUPABASE_URL"];
  const region = browserEnv["VITE_BOARD_FUNCTIONS_REGION"];
  console.log(
    `\n$ bun run dev:board  → ${url} (publishable key as apikey${region ? `; functions pinned to ${region}` : ""}; sign in at /login)`,
  );
  run("bun", ["run", "dev:board"], browserEnv);
}

export function boardFrontendCloudEnv(env: Record<string, string>): Record<string, string> {
  const url = env["VITE_BOARD_SUPABASE_URL"] ?? env["BOARD_SUPABASE_URL"];
  const key = env["VITE_BOARD_PUBLISHABLE_KEY"] ?? env["BOARD_PUBLISHABLE_KEY"];
  // Regional invocation pin — pass the DATABASE's region so edge functions execute next to it rather
  // than next to the caller (x-region header; see apps/board/src/config.ts). Optional but strongly
  // recommended for any project whose region differs from yours: without it every function→DB
  // statement pays the cross-region round trip.
  if (!url || !key) {
    throw new Error(
      "To run the frontend against the cloud backend, board.cloud.env needs BOARD_SUPABASE_URL + " +
        "BOARD_PUBLISHABLE_KEY (or the VITE_BOARD_* equivalents).",
    );
  }
  const region = env["VITE_BOARD_FUNCTIONS_REGION"] ?? env["BOARD_FUNCTIONS_REGION"];
  return {
    VITE_BOARD_SUPABASE_URL: url,
    VITE_BOARD_PUBLISHABLE_KEY: key,
    ...(region ? { VITE_BOARD_FUNCTIONS_REGION: region } : {}),
  };
}

function preview(env: Record<string, string>): void {
  const browserEnv = boardFrontendCloudEnv(env);
  const url = browserEnv["VITE_BOARD_SUPABASE_URL"];
  console.log(`\nBuilding the compiled board client against ${url}.`);
  run("bun", ["run", "--cwd", "apps/board", "build"], browserEnv);
  console.log("\nServing the compiled board at http://localhost:5173.");
  run("bun", ["run", "--cwd", "apps/board", "preview"], browserEnv);
}

function main(): void {
  const arg = (process.argv[2] ?? "deploy") as Step | "dev" | "preview" | "reset";
  if (
    arg !== "deploy" &&
    arg !== "dev" &&
    arg !== "preview" &&
    arg !== "reset" &&
    !STEPS.includes(arg) &&
    arg !== "purge"
  ) {
    throw new Error(`Unknown step "${arg}". Use one of: deploy, reset, dev, preview, purge, ${STEPS.join(", ")}.`);
  }
  const env = loadCloudEnv();

  if (arg === "dev") {
    dev(env);
    return;
  }
  if (arg === "preview") {
    preview(env);
    return;
  }

  const steps = arg === "deploy" ? STEPS : arg === "reset" ? RESET_STEPS : [arg];

  // Preflight the Supabase CLI once, up front, when any step needs it — so a missing CLI fails before
  // the (slower, mutating) migrate rather than between steps.
  if (steps.includes("secrets") || steps.includes("functions")) {
    requireSupabaseCli();
  }

  const project = boardSupabaseProject(env);
  console.log(
    `Board → Supabase Cloud (${project.url}; project ref ${project.ref}) + Electric Cloud. Steps: ${steps.join(" → ")}`,
  );
  for (const step of steps) {
    if (step === "purge") purge(env);
    else if (step === "migrate") migrate(env);
    else if (step === "secrets") secrets(env);
    else if (step === "functions") functions(env);
    else if (step === "seed") seed(env);
  }

  if (arg === "deploy") {
    console.log("\n✓ Cloud deploy complete. Run `bun run board:cloud:dev` to drive it from the local Vite client.");
  }
}

if (import.meta.main) main();
