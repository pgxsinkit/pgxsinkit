#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

const AGENT = "codex";
const CATALOG_COMMAND = "bunx @tanstack/intent@latest list --json --no-notices";
const EDIT_TOOLS = new Set(["Edit", "Write", "apply_patch"]);
const GATE_DENY_REASON =
  "Blocked: load matching TanStack guidance before editing. Follow this repo's TanStack guidance setup, then retry the edit.";
const INTENT_COMMAND_PATTERN =
  /(?:^|&&|\|\||;|\|)\s*((?:bunx\s+@tanstack\/intent(?:@latest)?)|(?:pnpm\s+exec\s+intent)|(?:pnpm\s+dlx\s+@tanstack\/intent(?:@latest)?)|(?:npx\s+@tanstack\/intent(?:@latest)?)|(?:yarn\s+dlx\s+@tanstack\/intent(?:@latest)?)|(?:intent))\s+(list|load)(?:\s+([^\s|;&]+))?/i;

try {
  await main();
} catch {}

process.exit(0);

async function main() {
  const event = readEventFromStdin();

  if (isSessionStartEvent(event)) {
    const additionalContext = await createSessionCatalogContext(rootForEvent(event));
    if (additionalContext) {
      process.stdout.write(JSON.stringify(sessionStartOutput(additionalContext)));
    }
    return;
  }

  const stateFile = stateFileForEvent(event);
  const observation = observationFromEvent(event);

  if (observation) {
    appendObservation(stateFile, observation);
  }

  const toolName = event?.tool_name ?? event?.toolName;
  if (typeof toolName === "string" && EDIT_TOOLS.has(toolName) && !hasLoad(stateFile)) {
    process.stdout.write(JSON.stringify(denyOutput()));
  }
}

function readEventFromStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function isSessionStartEvent(event) {
  return (event?.hook_event_name ?? event?.hookEventName) === "SessionStart";
}

function rootForEvent(event) {
  return typeof event?.cwd === "string" ? event.cwd : process.cwd();
}

async function createSessionCatalogContext(root) {
  try {
    const start = performance.now();
    const result = readIntentList(root);
    const durationMs = performance.now() - start;
    console.error(
      `[intent-${AGENT}-session-catalog] listIntentSkills found ${result.skills.length} skills from ${result.packages.length} packages in ${formatDuration(durationMs)} (packageJsonReadCount=${result.debug?.scan.packageJsonReadCount ?? "unknown"})`,
    );
    return formatSessionCatalog(result);
  } catch {
    return "";
  }
}

function readIntentList(root) {
  const output = execFileSync(CATALOG_COMMAND, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, INTENT_AUDIENCE: "agent" },
    maxBuffer: 1024 * 1024,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 9000,
  });
  return JSON.parse(output);
}

function formatDuration(durationMs) {
  return `${durationMs.toFixed(1)}ms`;
}

function formatSessionCatalog(result) {
  if (!Array.isArray(result.skills) || result.skills.length === 0) return "";

  return [
    "TanStack Intent skills are available in this repository.",
    "",
    "Before substantial work, check whether one listed skill clearly matches the user task. If one clearly matches, load that full skill guidance with the Intent CLI before proceeding.",
    "",
    "If no skill clearly matches, continue normally. Do not load a skill just to improve phrasing or gather nonessential context.",
    "",
    "Available local Intent skills:",
    formatSkillCatalog(result.skills),
    formatWarnings(result),
  ]
    .filter(Boolean)
    .join("\n");
}

function formatSkillCatalog(skills) {
  return skills.map((skill) => `- ${skill.use}: ${normalizeDescription(skill.description)}`).join("\n");
}

function normalizeDescription(description) {
  return typeof description === "string" ? description.replace(/\s+/g, " ").trim() : "";
}

function formatWarnings(result) {
  const warnings = [
    ...(Array.isArray(result.warnings) ? result.warnings : []),
    ...(Array.isArray(result.conflicts)
      ? result.conflicts.map(
          (conflict) => `Version conflict for ${conflict.packageName}; using ${conflict.chosen.version}`,
        )
      : []),
  ];

  if (warnings.length === 0) return "";
  return `\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
}

function sessionStartOutput(additionalContext) {
  if (AGENT === "copilot") {
    return { additionalContext };
  }

  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };
}

function stateFileForEvent(event) {
  const sessionId = typeof event?.session_id === "string" ? event.session_id : "unknown";
  const cwd = typeof event?.cwd === "string" ? event.cwd : process.cwd();
  const key = createHash("sha256")
    .update(AGENT + "\0" + cwd + "\0" + sessionId)
    .digest("hex");
  return join(tmpdir(), "tanstack-intent-hooks", key + ".jsonl");
}

function observationFromEvent(event) {
  if (!event || typeof event !== "object") return undefined;
  const toolName = event.tool_name ?? event.toolName;
  const toolInput = event.tool_input ?? event.toolArgs;
  if (toolName !== "Bash") return undefined;
  const command = typeof toolInput === "string" ? safeCommandFromString(toolInput) : commandFromObject(toolInput);
  const parsed = parseIntentInvocation(command);
  if (!parsed || typeof command !== "string") return undefined;
  return { action: parsed.action, skillUse: parsed.skillUse, raw: command };
}

function parseIntentInvocation(command) {
  if (typeof command !== "string") return undefined;
  const match = command.match(INTENT_COMMAND_PATTERN);
  if (!match?.[1] || !match[2]) return undefined;
  const action = match[2].toLowerCase();
  if (action !== "list" && action !== "load") return undefined;
  const skillUse = action === "load" ? match[3] : undefined;
  if (action === "load" && !skillUse) return undefined;
  return action === "load" ? { action, skillUse } : { action };
}

function commandFromObject(value) {
  return value && typeof value === "object" ? value.command : undefined;
}

function safeCommandFromString(value) {
  try {
    const command = commandFromObject(JSON.parse(value));
    return typeof command === "string" ? command : value;
  } catch {
    return value;
  }
}

function appendObservation(stateFile, observation) {
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    appendFileSync(stateFile, JSON.stringify({ ts: new Date().toISOString(), ...observation }) + "\n");
  } catch {}
}

function hasLoad(stateFile) {
  if (!existsSync(stateFile)) return false;
  try {
    return readFileSync(stateFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .some((line) => {
        try {
          return JSON.parse(line).action === "load";
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

function denyOutput() {
  if (AGENT === "copilot") {
    return { permissionDecision: "deny", permissionDecisionReason: GATE_DENY_REASON };
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: GATE_DENY_REASON,
    },
  };
}
