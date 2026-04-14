import { Repl } from "@electric-sql/pglite-repl";
import { startTransition, useEffect, useMemo, useState } from "react";

import type { MutationBatchItem, MutationDetail, MutationDiagnostics } from "@pgxsinkit/client";
import { getSyncRegistrySchema } from "@pgxsinkit/contracts";
import {
  buildSyntheticRegistrySchemaName,
  buildSyntheticCreatePayload,
  buildSyntheticRegistry,
  buildSyntheticUpdatePatch,
  countSyntheticWorkloadRows,
  demoAuthTokenByIdentity,
  defaultSyntheticPerfLabScenario,
  findSyntheticPerfLabScenarioDefinition,
  pickSyntheticWorkloadTarget,
  syntheticPerfLabPresets,
  type DemoAuthIdentity,
  type SyntheticPerfLabPreset,
  type SyntheticPerfLabScenario,
  type SyntheticRegistryBundle,
  type SyntheticRegistryOptions,
} from "@pgxsinkit/demo";

import {
  buildPerfDataDir,
  getPerfLabConnectionDefaults,
  loadPerfClient,
  type PerfLabClient,
  type PerfLabDb,
  type PerfLabConnectionMode,
} from "./pglite";
import { createReplProxy } from "./repl-proxy";

type LabStatus = "idle" | "booting" | "ready" | "running" | "error";
type ScenarioInput = SyntheticPerfLabScenario;
type Tab = "lab" | "repl";

type Percentiles = {
  p50: number;
  p95: number;
  p99: number;
};

type JournalBreakdown = {
  pending: number;
  sending: number;
  failed: number;
  acked: number;
};

type FailedMutationSample = {
  tableName: string;
  entityKeyLabel: string;
  mutationId: string;
  mutationSeq: number;
  mutationKind: string;
  attemptCount: number;
  lastHttpStatus: number | null;
  reason: string;
  updatedAtUs: string;
};

type ConnectionInput = {
  mode: PerfLabConnectionMode;
  writeUrl: string;
  batchWriteUrl: string;
  electricUrl: string;
  authIdentity: DemoAuthIdentity;
  syncEnabled: boolean;
};

type LabMetrics = {
  rowsSeeded: number;
  pendingMutations: number;
  activeTable: string;
  overlayBreakdown: Record<string, number>;
  journalBreakdown: JournalBreakdown;
  failedMutationSamples: FailedMutationSample[];
  mutationLatencyMs: Percentiles | null;
  readLatencyMs: Percentiles | null;
  flushSweepMs: number | null;
  convergenceSweepMs: number | null;
  reconcileSweepMs: number | null;
  flushOutcome: string | null;
  lastRunAt: string | null;
};

type BootstrapOptions = {
  seedRows?: number;
};

type PerfLabProvisionResponse = {
  ok: true;
  schemaName: string | null;
  activeTable: string | null;
};

type ProgressState = {
  label: string;
  completed: number;
  total: number;
} | null;

type PerfLabMutationBatchItem = Extract<MutationBatchItem<SyntheticRegistryBundle["registry"]>, { kind: "update" }>;

const defaultScenario: ScenarioInput = {
  ...defaultSyntheticPerfLabScenario,
  mutationBatchSize: readPositiveIntEnv(
    "VITE_PGXSINKIT_PERF_MUTATION_BATCH_SIZE",
    defaultSyntheticPerfLabScenario.mutationBatchSize,
  ),
};
const connectionDefaults = getPerfLabConnectionDefaults();
const defaultPresetKey =
  defaultScenario.mutationBatchSize === defaultSyntheticPerfLabScenario.mutationBatchSize
    ? (syntheticPerfLabPresets[0]?.key ?? null)
    : null;

const defaultConnection: ConnectionInput = {
  mode: "live",
  writeUrl: connectionDefaults.liveWriteUrl,
  batchWriteUrl: connectionDefaults.liveBatchWriteUrl,
  electricUrl: connectionDefaults.liveElectricUrl,
  authIdentity: "user1",
  syncEnabled: true,
};

const initialMetrics: LabMetrics = {
  rowsSeeded: 0,
  pendingMutations: 0,
  activeTable: "No tables prepared",
  overlayBreakdown: {},
  journalBreakdown: {
    pending: 0,
    sending: 0,
    failed: 0,
    acked: 0,
  },
  failedMutationSamples: [],
  mutationLatencyMs: null,
  readLatencyMs: null,
  flushSweepMs: null,
  convergenceSweepMs: null,
  reconcileSweepMs: null,
  flushOutcome: null,
  lastRunAt: null,
};

export function App() {
  const [scenario, setScenario] = useState<ScenarioInput>(defaultScenario);
  const [selectedPresetKey, setSelectedPresetKey] = useState<string | null>(defaultPresetKey);
  const [connection, setConnection] = useState<ConnectionInput>(defaultConnection);
  const [tab, setTab] = useState<Tab>("lab");
  const [status, setStatus] = useState<LabStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState<ProgressState>(null);
  const [metrics, setMetrics] = useState<LabMetrics>(initialMetrics);
  const [runId, setRunId] = useState(() => createRunId());
  const [client, setClient] = useState<PerfLabClient | null>(null);
  const [bundle, setBundle] = useState<SyntheticRegistryBundle | null>(null);
  const [preparedScenario, setPreparedScenario] = useState<ScenarioInput | null>(null);
  const [preparedConnection, setPreparedConnection] = useState<ConnectionInput | null>(null);
  const [runtimeDescriptor, setRuntimeDescriptor] = useState<string | null>(null);
  const replProxy = useMemo(() => (client ? createReplProxy(client.pglite) : null), [client]);
  const localSchemaName = bundle ? getSyncRegistrySchema(bundle.registry) : resolveLocalScenarioSchemaName(scenario);

  useEffect(() => {
    return () => {
      if (client) {
        void client.destroy();
      }
    };
  }, [client]);

  async function handlePrepareLab() {
    await bootstrapLab(scenario);
  }

  function handleApplyPreset(preset: SyntheticPerfLabPreset) {
    setScenario({ ...preset.scenario });
    setSelectedPresetKey(preset.key);
    appendLog(`Loaded preset ${preset.label}: ${preset.description}`);
  }

  function updateScenario<Key extends keyof ScenarioInput>(key: Key, value: ScenarioInput[Key]) {
    setSelectedPresetKey(null);
    setScenario((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function updateConnection<Key extends keyof ConnectionInput>(key: Key, value: ConnectionInput[Key]) {
    setConnection((current) => ({
      ...current,
      [key]: value,
    }));
  }

  async function handleResetLab() {
    if (!client || !bundle) {
      setProgress(null);
      setMetrics({
        ...initialMetrics,
        activeTable: describeHotTableScope(null),
      });
      setStatus("idle");
      setError(null);
      appendLog("Reset requested before the lab was prepared.");
      return;
    }

    setStatus("running");
    setError(null);

    try {
      const scenarioToReset = preparedScenario ?? scenario;
      const connectionToReset = preparedConnection ?? connection;

      const runtime = await bootstrapLab(scenarioToReset, connectionToReset);

      if (!runtime) {
        return;
      }

      setProgress(null);
      setMetrics({
        ...initialMetrics,
        activeTable: describeHotTableScope(runtime.bundle),
      });
      setStatus("ready");
      appendLog(`Reset lab state for local schema ${getSyncRegistrySchema(runtime.bundle.registry)}.`);
    } catch (reason) {
      handleError(reason, "Failed to reset perf lab");
    }
  }

  async function handleSeedRows() {
    const runtime = await bootstrapLab(scenario, connection, { seedRows: scenario.localRows });

    if (!runtime) {
      return;
    }

    const tableScope = describeHotTableScope(runtime.bundle);
    const totalRows = countSyntheticWorkloadRows(runtime.bundle.tableNames.length, scenario.localRows);

    setStatus("running");
    setError(null);
    appendLog(
      `Seeding ${formatCount(scenario.localRows)} rows per table across ${formatCount(runtime.bundle.tableNames.length)} tables (${formatCount(totalRows)} total rows)`,
    );

    try {
      await refreshMetrics(runtime.client, runtime.bundle);
      setStatus("ready");
      appendLog(`Seed complete across ${tableScope}`);
    } catch (reason) {
      handleError(reason, "Failed to seed perf-lab rows");
    }
  }

  async function handleStageMutations() {
    const runtime = await ensureRuntime();
    const tableScope = describeHotTableScope(runtime.bundle);

    setStatus("running");
    setError(null);
    appendLog(
      `Staging ${formatCount(scenario.pendingMutations)} pending mutations across ${tableScope} in batches of ${formatCount(scenario.mutationBatchSize)}`,
    );

    try {
      const timings = await stagePendingMutations(
        runtime.client,
        runtime.bundle,
        scenario.pendingMutations,
        scenario.mutationBatchSize,
        scenario.localRows,
        scenario.extraColumnCount,
        setProgress,
      );

      await refreshMetrics(runtime.client, runtime.bundle, {
        mutationLatencyMs: computePercentiles(timings),
      });
      setStatus("ready");
      appendLog(`Pending journal staged across ${tableScope}`);
    } catch (reason) {
      handleError(reason, "Failed to stage pending mutations");
    }
  }

  async function handleMeasureReads() {
    const runtime = await ensureRuntime();
    const tableScope = describeHotTableScope(runtime.bundle);

    setStatus("running");
    setError(null);
    appendLog(`Measuring ${formatCount(scenario.readSamples)} optimistic point reads across ${tableScope}`);

    try {
      const timings = await measurePointReads(
        runtime.client,
        runtime.bundle,
        scenario.readSamples,
        Math.max(1, scenario.localRows),
        scenario.extraColumnCount,
        setProgress,
      );

      await refreshMetrics(runtime.client, runtime.bundle, {
        readLatencyMs: computePercentiles(timings),
      });
      setStatus("ready");
      appendLog(`Read sampling complete across ${tableScope}`);
    } catch (reason) {
      handleError(reason, "Failed to measure optimistic reads");
    }
  }

  async function handleMeasureReconcile() {
    const runtime = await ensureRuntime();
    const tableScope = describeHotTableScope(runtime.bundle);

    setStatus("running");
    setError(null);
    appendLog(`Measuring reconcile sweep across ${tableScope}`);

    try {
      const reconcileSweepMs = await measureReconcileSweep(runtime.client, runtime.bundle, setProgress);

      await refreshMetrics(runtime.client, runtime.bundle, {
        reconcileSweepMs,
      });
      setStatus("ready");
      appendLog(`Reconcile sweep complete across ${tableScope}`);
    } catch (reason) {
      handleError(reason, "Failed to measure reconcile sweep");
    }
  }

  async function handleMeasureFlush() {
    const runtime = await ensureRuntime();
    const tableScope = describeHotTableScope(runtime.bundle);

    setStatus("running");
    setError(null);
    appendLog(`Measuring ${connection.mode === "live" ? "live" : "offline"} flush sweep across ${tableScope}`);

    try {
      const flushSummary = await measureFlushSweep(
        runtime.client,
        runtime.bundle,
        scenario.localRows,
        connection.mode === "live" && connection.syncEnabled,
        setProgress,
      );

      await refreshMetrics(runtime.client, runtime.bundle, {
        flushSweepMs: flushSummary.durationMs,
        convergenceSweepMs: flushSummary.convergenceMs,
        flushOutcome: flushSummary.outcome,
        failedMutationSamples: flushSummary.failedMutationSamples,
      });
      setStatus("ready");
      appendLog(`Flush sweep complete across ${tableScope}: ${flushSummary.outcome}`);
    } catch (reason) {
      handleError(reason, "Failed to measure flush sweep");
    }
  }

  async function handleRunFullScenario() {
    const runtime = await bootstrapLab(scenario, connection, { seedRows: scenario.localRows });

    if (!runtime) {
      return;
    }

    const tableScope = describeHotTableScope(runtime.bundle);

    setStatus("running");
    setError(null);
    appendLog(`Running full end-to-end scenario across ${tableScope}`);

    try {
      const mutationTimings = await stagePendingMutations(
        runtime.client,
        runtime.bundle,
        scenario.pendingMutations,
        scenario.mutationBatchSize,
        scenario.localRows,
        scenario.extraColumnCount,
        setProgress,
      );
      const readTimings = await measurePointReads(
        runtime.client,
        runtime.bundle,
        scenario.readSamples,
        Math.max(1, scenario.localRows),
        scenario.extraColumnCount,
        setProgress,
      );
      const reconcileSweepMs = await measureReconcileSweep(runtime.client, runtime.bundle, setProgress);
      const flushSummary = await measureFlushSweep(
        runtime.client,
        runtime.bundle,
        scenario.localRows,
        connection.mode === "live" && connection.syncEnabled,
        setProgress,
      );

      await refreshMetrics(runtime.client, runtime.bundle, {
        mutationLatencyMs: computePercentiles(mutationTimings),
        readLatencyMs: computePercentiles(readTimings),
        reconcileSweepMs,
        flushSweepMs: flushSummary.durationMs,
        convergenceSweepMs: flushSummary.convergenceMs,
        flushOutcome: flushSummary.outcome,
        failedMutationSamples: flushSummary.failedMutationSamples,
      });
      setStatus("ready");
      appendLog(`Full end-to-end scenario complete across ${tableScope}`);
    } catch (reason) {
      handleError(reason, "Full scenario failed");
    }
  }

  async function bootstrapLab(
    nextScenario: ScenarioInput,
    nextConnection: ConnectionInput = connection,
    options: BootstrapOptions = {},
  ) {
    let loadedClient: Awaited<ReturnType<typeof loadPerfClient>> | null = null;

    if (client) {
      await client.destroy();
    }

    setStatus("booting");
    setError(null);
    setProgress(null);
    setClient(null);
    setBundle(null);
    setPreparedScenario(null);
    setPreparedConnection(null);
    setRuntimeDescriptor(null);

    let schemaName = resolveLocalScenarioSchemaName(nextScenario);

    if (nextConnection.mode === "live") {
      appendLog("Provisioning dedicated perf-lab backend for the active synthetic registry");
      const provisioned = await provisionPerfLabBackend(nextConnection, nextScenario);
      schemaName = provisioned.schemaName ?? schemaName;
    }

    const registryOptions: SyntheticRegistryOptions = {
      tableCount: Math.max(1, nextScenario.tableCount),
      extraColumnCount: Math.max(1, nextScenario.extraColumnCount),
      ...(schemaName ? { schemaName } : {}),
    };
    const nextBundle = buildSyntheticRegistry(registryOptions);
    const nextRunId = createRunId();
    const nextRuntimeDescriptor = buildRuntimeDescriptor(nextScenario, nextConnection);
    const authToken = demoAuthTokenByIdentity[nextConnection.authIdentity];

    appendLog(
      `Preparing browser lab with ${registryOptions.tableCount} tables, ${registryOptions.extraColumnCount} extra columns, local schema ${schemaName}, ${describeConnection(nextConnection)}, and data dir ${buildPerfDataDir(nextRunId)}`,
    );

    const shouldPreseedRemoteRows =
      nextConnection.mode === "live" &&
      nextConnection.syncEnabled &&
      authToken !== undefined &&
      (options.seedRows ?? 0) > 0;
    const totalSeedRows = countSyntheticWorkloadRows(nextBundle.tableNames.length, options.seedRows ?? 0);

    try {
      if (shouldPreseedRemoteRows) {
        setProgress({
          label: "Seeding dedicated perf-lab backend",
          completed: 0,
          total: totalSeedRows,
        });
        await yieldToBrowser();
        await seedPerfLabBackend(nextConnection, options.seedRows!);
      }

      loadedClient = await loadPerfClient(
        nextBundle.registry,
        buildPerfDataDir(nextRunId),
        {
          mode: nextConnection.mode,
          writeUrl: nextConnection.writeUrl,
          batchWriteUrl: nextConnection.batchWriteUrl,
          electricUrl: nextConnection.electricUrl,
          authToken,
          syncEnabled: nextConnection.syncEnabled,
        },
        {
          prepareLocalDb: async (db) => {
            await truncateLocalPerfLabTablesInDb(db, nextBundle);
          },
        },
      );
      await loadedClient.client.ready;

      if (shouldPreseedRemoteRows) {
        await waitForSyncedSeed(loadedClient.client, nextBundle, options.seedRows!, setProgress);
      } else if ((options.seedRows ?? 0) > 0) {
        await seedLabRows(
          loadedClient.client,
          nextBundle,
          nextScenario,
          nextConnection,
          options.seedRows!,
          setProgress,
        );
      }

      const readyClient = loadedClient.client;

      startTransition(() => {
        setClient(readyClient);
        setBundle(nextBundle);
        setPreparedScenario({ ...nextScenario });
        setPreparedConnection({ ...nextConnection });
        setRuntimeDescriptor(nextRuntimeDescriptor);
        setRunId(nextRunId);
        setStatus("ready");
        setMetrics({
          ...initialMetrics,
          activeTable: describeHotTableScope(nextBundle),
        });
      });

      appendLog(`Browser lab ready. Hot tables: ${describeHotTableScope(nextBundle)}`);
      return { client: readyClient, bundle: nextBundle };
    } catch (reason) {
      if (loadedClient) {
        await loadedClient.dispose();
      }

      handleError(reason, "Failed to bootstrap perf lab");
      return null;
    }
  }

  async function ensureRuntime() {
    const expectedRuntimeDescriptor = buildRuntimeDescriptor(scenario, connection);

    if (client && bundle && runtimeDescriptor === expectedRuntimeDescriptor) {
      return { client, bundle };
    }

    const runtime = await bootstrapLab(scenario, connection);

    if (!runtime) {
      throw new Error("Perf lab is not ready yet");
    }

    return runtime;
  }

  function appendLog(message: string) {
    const line = `${new Date().toLocaleTimeString()}  ${message}`;
    startTransition(() => {
      setLogs((current) => [line, ...current].slice(0, 40));
    });
  }

  function handleError(reason: unknown, fallbackMessage: string) {
    const message = reason instanceof Error ? reason.message : fallbackMessage;
    setStatus("error");
    setError(message);
    appendLog(message);
  }

  async function refreshMetrics(
    currentClient: PerfLabClient,
    currentBundle: SyntheticRegistryBundle,
    overrides?: Partial<LabMetrics>,
  ) {
    const [{ mutation }, rowCounts, overlayBreakdown, mutationDetails] = await Promise.all([
      currentClient.diagnostics(),
      queryRowCounts(currentClient, currentBundle),
      queryOverlayBreakdown(currentClient, currentBundle),
      currentClient.readMutationDetails(),
    ]);
    const failedMutationSamples = summarizeFailedMutations(mutationDetails);
    const rowCount = Object.values(rowCounts).reduce((total, value) => total + value, 0);

    startTransition(() => {
      setProgress(null);
      setMetrics((current) => ({
        ...current,
        rowsSeeded: rowCount,
        pendingMutations: mutation.pendingCount + mutation.sendingCount + mutation.failedCount,
        overlayBreakdown,
        journalBreakdown: {
          pending: mutation.pendingCount,
          sending: mutation.sendingCount,
          failed: mutation.failedCount,
          acked: mutation.ackedCount,
        },
        failedMutationSamples,
        activeTable: describeHotTableScope(currentBundle),
        lastRunAt: new Date().toISOString(),
        ...overrides,
      }));
    });
  }

  return (
    <main className="shell" data-tab={tab}>
      <nav className="tab-nav">
        <button
          type="button"
          className={`tab-btn${tab === "lab" ? " tab-btn--active" : ""}`}
          onClick={() => setTab("lab")}
        >
          Lab
        </button>
        <button
          type="button"
          className={`tab-btn${tab === "repl" ? " tab-btn--active" : ""}`}
          onClick={() => setTab("repl")}
        >
          PGlite REPL
        </button>
      </nav>

      <section className="repl-panel" style={tab === "repl" ? undefined : { display: "none" }}>
        {replProxy ? <Repl pg={replProxy} border theme="auto" showTime /> : <p>Prepare the lab to inspect PGlite.</p>}
      </section>

      <div style={tab === "lab" ? undefined : { display: "none" }}>
        <section className="hero">
          <p className="eyebrow">Browser Perf Lab</p>
          <p className="lede">
            This lab exercises the real browser PGlite client against a dedicated perf-lab backend, synthetic registry
            topologies, and browser-local read models so large-shape lifecycle changes can be measured without leaving
            the app.
          </p>
        </section>

        <section className="status-strip panel">
          <div>
            <span className={`status-pill status-${status}`}>{status.toUpperCase()}</span>
            <p className="status-copy">Data dir: {buildPerfDataDir(runId)}</p>
          </div>
          <div>
            <strong>{metrics.activeTable}</strong>
            <p className="status-copy">
              Hot tables participating in seeding, mutation pressure, point-read sampling, and sweeps in local schema{" "}
              {localSchemaName}. {describeConnection(connection)}.
            </p>
          </div>
        </section>

        <section className="layout-grid">
          <article className="panel control-panel">
            <div className="section-header">
              <p className="section-kicker">Scenario</p>
              <h2>Configure the synced shape</h2>
            </div>

            <div className="preset-grid">
              {syntheticPerfLabPresets.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className={`preset-button${selectedPresetKey === preset.key ? " preset-selected" : ""}`}
                  onClick={() => handleApplyPreset(preset)}
                  disabled={status === "booting" || status === "running"}
                >
                  <strong>{preset.label}</strong>
                  <span>{preset.description}</span>
                </button>
              ))}
            </div>

            <div className="section-header compact">
              <p className="section-kicker">Connection</p>
              <h3>Flush target and auth</h3>
            </div>

            <div className="field-grid">
              <SelectField
                label="Connection mode"
                value={connection.mode}
                onChange={(value) => updateConnection("mode", value as PerfLabConnectionMode)}
                options={[
                  { value: "live", label: "Live backend" },
                  { value: "offline", label: "Offline loopback" },
                ]}
              />
              <SelectField
                label="Demo auth identity"
                value={connection.authIdentity}
                onChange={(value) => updateConnection("authIdentity", value as DemoAuthIdentity)}
                options={[
                  { value: "none", label: "none" },
                  { value: "user1", label: "user1" },
                  { value: "user2", label: "user2" },
                  { value: "admin", label: "admin" },
                ]}
              />
              <TextField
                label="Write API URL"
                value={connection.writeUrl}
                onChange={(value) => updateConnection("writeUrl", value)}
                disabled={connection.mode === "offline"}
                placeholder={connectionDefaults.liveWriteUrl}
              />
              <TextField
                label="Batch write URL"
                value={connection.batchWriteUrl}
                onChange={(value) => updateConnection("batchWriteUrl", value)}
                disabled={connection.mode === "offline"}
                placeholder={connectionDefaults.liveBatchWriteUrl}
              />
              <TextField
                label="Electric URL"
                value={connection.electricUrl}
                onChange={(value) => updateConnection("electricUrl", value)}
                disabled={connection.mode === "offline"}
                placeholder={connectionDefaults.liveElectricUrl}
              />
              <SelectField
                label="Sync echo"
                value={connection.syncEnabled ? "enabled" : "disabled"}
                onChange={(value) => updateConnection("syncEnabled", value === "enabled")}
                disabled={connection.mode === "offline"}
                options={[
                  { value: "disabled", label: "disabled" },
                  { value: "enabled", label: "enabled" },
                ]}
              />
            </div>

            <p className="control-note">{describeConnectionNote(connection)}</p>

            <div className="field-grid">
              <NumberField
                label="Table count"
                value={scenario.tableCount}
                onChange={(value) => updateScenario("tableCount", value)}
              />
              <NumberField
                label="Extra columns per table"
                value={scenario.extraColumnCount}
                onChange={(value) => updateScenario("extraColumnCount", value)}
              />
              <NumberField
                label="Rows per table"
                value={scenario.localRows}
                onChange={(value) => updateScenario("localRows", value)}
              />
              <NumberField
                label="Pending mutations"
                value={scenario.pendingMutations}
                onChange={(value) => updateScenario("pendingMutations", value)}
              />
              <NumberField
                label="Mutation batch size"
                value={scenario.mutationBatchSize}
                onChange={(value) => updateScenario("mutationBatchSize", value)}
              />
              <NumberField
                label="Point-read samples"
                value={scenario.readSamples}
                onChange={(value) => updateScenario("readSamples", value)}
              />
            </div>

            <div className="button-grid">
              <button onClick={() => void handlePrepareLab()} disabled={status === "booting" || status === "running"}>
                Prepare lab
              </button>
              <button onClick={() => void handleSeedRows()} disabled={status === "booting" || status === "running"}>
                Seed rows
              </button>
              <button
                onClick={() => void handleStageMutations()}
                disabled={status === "booting" || status === "running"}
              >
                Stage mutations
              </button>
              <button onClick={() => void handleMeasureReads()} disabled={status === "booting" || status === "running"}>
                Measure reads
              </button>
              <button
                onClick={() => void handleMeasureReconcile()}
                disabled={status === "booting" || status === "running"}
              >
                Measure reconcile
              </button>
              <button onClick={() => void handleMeasureFlush()} disabled={status === "booting" || status === "running"}>
                Measure flush
              </button>
              <button
                className="wide-button"
                onClick={() => void handleRunFullScenario()}
                disabled={status === "booting" || status === "running"}
              >
                Run full cycle
              </button>
              <button
                className="secondary-button"
                onClick={() => void handleResetLab()}
                disabled={status === "running"}
              >
                Reset lab
              </button>
            </div>

            {progress ? (
              <div className="progress-card">
                <div className="progress-header">
                  <strong>{progress.label}</strong>
                  <span>
                    {formatCount(progress.completed)} / {formatCount(progress.total)}
                  </span>
                </div>
                <div className="progress-track">
                  <div
                    className="progress-bar"
                    style={{ width: `${Math.min(100, (progress.completed / Math.max(1, progress.total)) * 100)}%` }}
                  />
                </div>
              </div>
            ) : null}

            {error ? <p className="error-card">{error}</p> : null}
          </article>

          <article className="panel metrics-panel">
            <div className="section-header">
              <p className="section-kicker">Measurements</p>
              <h2>Full-cycle pressure snapshot</h2>
            </div>

            <div className="metrics-grid">
              <MetricCard label="Rows seeded" value={formatCount(metrics.rowsSeeded)} />
              <MetricCard label="Journal backlog" value={formatCount(metrics.pendingMutations)} />
              <MetricCard label="Failed journal" value={formatCount(metrics.journalBreakdown.failed)} />
              <MetricCard label="Mutation p95" value={formatDuration(metrics.mutationLatencyMs?.p95)} />
              <MetricCard label="Read p95" value={formatDuration(metrics.readLatencyMs?.p95)} />
            </div>

            <div className="percentile-grid">
              <PercentilePanel label="Mutation latency" values={metrics.mutationLatencyMs} accent="warm" />
              <PercentilePanel label="Read latency" values={metrics.readLatencyMs} accent="cool" />
            </div>

            <div className="operation-grid">
              <SweepCard
                label="Reconcile sweep"
                value={formatDuration(metrics.reconcileSweepMs)}
                detail="Local overlay cleanup walk"
              />
              <SweepCard
                label="Flush sweep"
                value={formatDuration(metrics.flushSweepMs)}
                detail={metrics.flushOutcome ?? "Flush has not run yet"}
              />
              <SweepCard
                label="Sync convergence"
                value={formatDuration(metrics.convergenceSweepMs)}
                detail={
                  connection.mode === "live" && connection.syncEnabled
                    ? "Ack replay from Electric into PGlite and overlay cleanup"
                    : "Disabled unless live mode and sync echo are both enabled"
                }
              />
            </div>

            <div className="detail-grid">
              <div className="overlay-card">
                <div className="section-header compact">
                  <p className="section-kicker">Overlay mix</p>
                  <h3>Read-model breakdown</h3>
                </div>
                <ul className="overlay-list">
                  {Object.entries(metrics.overlayBreakdown).length > 0 ? (
                    Object.entries(metrics.overlayBreakdown).map(([overlayKind, count]) => (
                      <li key={overlayKind}>
                        <span>{overlayKind}</span>
                        <strong>{formatCount(count)}</strong>
                      </li>
                    ))
                  ) : (
                    <li>
                      <span>No overlay rows measured yet</span>
                      <strong>0</strong>
                    </li>
                  )}
                </ul>
              </div>

              <div className="overlay-card">
                <div className="section-header compact">
                  <p className="section-kicker">Journal state</p>
                  <h3>Mutation pipeline breakdown</h3>
                </div>
                <ul className="overlay-list">
                  <li>
                    <span>Pending</span>
                    <strong>{formatCount(metrics.journalBreakdown.pending)}</strong>
                  </li>
                  <li>
                    <span>Sending</span>
                    <strong>{formatCount(metrics.journalBreakdown.sending)}</strong>
                  </li>
                  <li>
                    <span>Failed</span>
                    <strong>{formatCount(metrics.journalBreakdown.failed)}</strong>
                  </li>
                  <li>
                    <span>Acked</span>
                    <strong>{formatCount(metrics.journalBreakdown.acked)}</strong>
                  </li>
                </ul>
              </div>

              <div className="overlay-card">
                <div className="section-header compact">
                  <p className="section-kicker">Flush errors</p>
                  <h3>Failed mutation samples</h3>
                </div>
                <ul className="log-list">
                  {metrics.failedMutationSamples.length > 0 ? (
                    metrics.failedMutationSamples.map((sample) => (
                      <li key={sample.mutationId}>{formatFailedMutationSample(sample)}</li>
                    ))
                  ) : (
                    <li>No failed mutations captured.</li>
                  )}
                </ul>
              </div>
            </div>
          </article>
        </section>

        <section className="panel journal-panel">
          <div className="section-header compact">
            <p className="section-kicker">Run log</p>
            <h2>Recent activity</h2>
          </div>
          <ul className="log-list">
            {logs.length > 0 ? (
              logs.map((entry) => <li key={entry}>{entry}</li>)
            ) : (
              <li>Prepare the lab to start a browser-backed end-to-end scenario.</li>
            )}
          </ul>
        </section>
      </div>
    </main>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={1}
        step={1}
        value={value}
        onChange={(event) => onChange(Math.max(1, Number.parseInt(event.target.value || "1", 10) || 1))}
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        placeholder={placeholder}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function SweepCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="metric-card sweep-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

function PercentilePanel({
  label,
  values,
  accent,
}: {
  label: string;
  values: Percentiles | null;
  accent: "warm" | "cool";
}) {
  return (
    <article className={`percentile-card percentile-${accent}`}>
      <span>{label}</span>
      <strong>{formatDuration(values?.p50)}</strong>
      <p>
        p95 {formatDuration(values?.p95)} · p99 {formatDuration(values?.p99)}
      </p>
    </article>
  );
}

async function seedLocalRows(
  client: PerfLabClient,
  bundle: SyntheticRegistryBundle,
  rowCount: number,
  extraColumnCount: number,
  onProgress: (progress: ProgressState) => void,
) {
  const columnNames = [
    "id",
    ...Array.from({ length: extraColumnCount }, (_, index) => `field_${index.toString().padStart(2, "0")}`),
    "owner_id",
    "modified_by",
    "status",
    "priority",
    "created_at_us",
    "updated_at_us",
  ];
  const batchSize = 250;
  const totalRows = countSyntheticWorkloadRows(bundle.tableNames.length, rowCount);
  let completedRows = 0;

  await truncateLocalPerfLabTables(client, bundle);

  for (const [tableIndex, tableName] of bundle.tableNames.entries()) {
    const qualifiedTableName = localProjectionName(bundle, tableName);

    for (let start = 0; start < rowCount; start += batchSize) {
      const batchEnd = Math.min(rowCount, start + batchSize);
      const values: Array<string | number> = [];
      const tuples: string[] = [];

      for (let rowIndex = start; rowIndex < batchEnd; rowIndex += 1) {
        const payload = buildSyntheticCreatePayload(tableIndex, rowIndex, extraColumnCount);
        const placeholders: string[] = [];

        values.push(String(payload.id));
        placeholders.push(`$${values.length}`);

        for (let columnIndex = 0; columnIndex < extraColumnCount; columnIndex += 1) {
          values.push(String(payload[`field${columnIndex.toString().padStart(2, "0")}`]));
          placeholders.push(`$${values.length}`);
        }

        values.push("11111111-1111-4111-8111-111111111111");
        placeholders.push(`$${values.length}`);
        values.push("11111111-1111-4111-8111-111111111111");
        placeholders.push(`$${values.length}`);
        values.push(String(payload.status));
        placeholders.push(`$${values.length}`);
        values.push(String(payload.priority));
        placeholders.push(`$${values.length}`);
        values.push(1_700_000_000_000_000 + rowIndex);
        placeholders.push(`$${values.length}`);
        values.push(1_700_000_000_000_000 + rowIndex);
        placeholders.push(`$${values.length}`);

        tuples.push(`(${placeholders.join(", ")})`);
      }

      await client.pglite.query(
        `INSERT INTO ${qualifiedTableName} (${columnNames.join(", ")}) VALUES ${tuples.join(", ")}`,
        values,
      );
      completedRows += batchEnd - start;
      onProgress({ label: "Seeding local rows across hot tables", completed: completedRows, total: totalRows });
      await yieldToBrowser();
    }
  }
}

async function stagePendingMutations(
  client: PerfLabClient,
  bundle: SyntheticRegistryBundle,
  pendingMutations: number,
  mutationBatchSize: number,
  localRows: number,
  extraColumnCount: number,
  onProgress: (progress: ProgressState) => void,
) {
  const timings: number[] = [];
  const effectiveBatchSize = Math.max(1, mutationBatchSize);

  for (let start = 0; start < pendingMutations; start += effectiveBatchSize) {
    const batchEnd = Math.min(pendingMutations, start + effectiveBatchSize);
    const batchItems: PerfLabMutationBatchItem[] = [];

    for (let index = start; index < batchEnd; index += 1) {
      const target = pickSyntheticWorkloadTarget(bundle.tableNames.length, index, localRows);
      const tableName = bundle.tableNames[target.tableIndex]!;
      const rowId = buildSyntheticCreatePayload(target.tableIndex, target.rowIndex, extraColumnCount).id as string;

      batchItems.push({
        table: tableName,
        kind: "update",
        entityKey: { id: rowId },
        patch: buildSyntheticUpdatePatch(index, extraColumnCount),
      });
    }

    const started = performance.now();

    if (batchItems.length === 1) {
      const onlyItem = batchItems[0]!;
      await client.mutate.update(onlyItem.table, onlyItem.entityKey, onlyItem.patch);
      timings.push(performance.now() - started);
    } else {
      await client.mutate.batch(batchItems);
      const perMutationMs = (performance.now() - started) / batchItems.length;

      for (let index = 0; index < batchItems.length; index += 1) {
        timings.push(perMutationMs);
      }
    }

    if (batchEnd % 100 === 0 || batchEnd === pendingMutations) {
      onProgress({
        label: `Staging pending mutations in batches of ${formatCount(effectiveBatchSize)}`,
        completed: batchEnd,
        total: pendingMutations,
      });
      await yieldToBrowser();
    }
  }

  return timings;
}

async function measurePointReads(
  client: PerfLabClient,
  bundle: SyntheticRegistryBundle,
  readSamples: number,
  localRows: number,
  extraColumnCount: number,
  onProgress: (progress: ProgressState) => void,
) {
  const timings: number[] = [];

  for (let index = 0; index < readSamples; index += 1) {
    const target = pickSyntheticWorkloadTarget(bundle.tableNames.length, index, localRows);
    const tableName = bundle.tableNames[target.tableIndex]!;
    const readModelName = localProjectionName(bundle, `${tableName}_read_model`);
    const rowId = buildSyntheticCreatePayload(target.tableIndex, target.rowIndex, extraColumnCount).id as string;
    const started = performance.now();
    const result = await client.pglite.query<{ id: string }>(`SELECT id FROM ${readModelName} WHERE id = $1`, [rowId]);
    timings.push(performance.now() - started);

    if (result.rows[0]?.id !== rowId) {
      throw new Error(`Expected read-model row ${rowId} but it was missing`);
    }

    if ((index + 1) % 100 === 0 || index + 1 === readSamples) {
      onProgress({ label: "Sampling optimistic reads across hot tables", completed: index + 1, total: readSamples });
      await yieldToBrowser();
    }
  }

  return timings;
}

async function measureReconcileSweep(
  client: PerfLabClient,
  _bundle: SyntheticRegistryBundle,
  onProgress: (progress: ProgressState) => void,
) {
  onProgress({ label: "Running reconcile sweep", completed: 0, total: 1 });
  await yieldToBrowser();

  const started = performance.now();
  await client.reconcile();
  const durationMs = performance.now() - started;

  onProgress({ label: "Running reconcile sweep", completed: 1, total: 1 });
  await yieldToBrowser();
  return durationMs;
}

async function measureFlushSweep(
  client: PerfLabClient,
  bundle: SyntheticRegistryBundle,
  expectedRowsPerTable: number,
  waitForConvergence: boolean,
  onProgress: (progress: ProgressState) => void,
) {
  const before = await client.diagnostics();

  onProgress({ label: "Running flush sweep", completed: 0, total: 1 });
  await yieldToBrowser();

  const started = performance.now();
  console.log("Starting flush sweep with mutation state", before.mutation);
  await client.flush();
  console.log("Flush sweep complete, fetching post-flush diagnostics and mutation details");
  const durationMs = performance.now() - started;
  const [after, mutationDetails] = await Promise.all([client.diagnostics(), client.readMutationDetails()]);
  console.log("Post-flush diagnostics", after);
  const afterMutation = after.mutation;
  const failedMutationSamples = summarizeFailedMutations(mutationDetails);
  let convergenceMs: number | null = null;

  if (
    waitForConvergence &&
    afterMutation.failedCount === 0 &&
    (afterMutation.ackedCount > 0 || afterMutation.pendingCount > 0)
  ) {
    const convergenceStarted = performance.now();
    console.log(
      "Flush resulted in pending or acked mutations, waiting for convergence with mutation state",
      afterMutation,
    );
    await waitForFlushConvergence(client, bundle, expectedRowsPerTable, onProgress);
    console.log("Convergence achieved");
    convergenceMs = performance.now() - convergenceStarted;
  }

  onProgress({ label: "Running flush sweep", completed: 1, total: 1 });
  await yieldToBrowser();

  return {
    durationMs,
    convergenceMs,
    outcome: describeFlushOutcome(before.mutation, afterMutation, convergenceMs, failedMutationSamples),
    failedMutationSamples,
  };
}

async function provisionPerfLabBackend(connection: ConnectionInput, scenario: ScenarioInput) {
  return await performPerfLabRequest<PerfLabProvisionResponse>(connection, "/api/perf-lab/provision", {
    method: "POST",
    body: {
      tableCount: scenario.tableCount,
      extraColumnCount: scenario.extraColumnCount,
    },
  });
}

async function seedLabRows(
  client: PerfLabClient,
  bundle: SyntheticRegistryBundle,
  scenario: ScenarioInput,
  connection: ConnectionInput,
  rowCount: number,
  onProgress: (progress: ProgressState) => void,
) {
  if (connection.mode === "offline") {
    await seedLocalRows(client, bundle, rowCount, scenario.extraColumnCount, onProgress);
    return;
  }

  if (connection.authIdentity === "none") {
    throw new Error(
      "Live perf-lab seeding requires a demo auth identity so the dedicated backend can apply RLS ownership.",
    );
  }

  onProgress({
    label: "Seeding dedicated perf-lab backend",
    completed: 0,
    total: countSyntheticWorkloadRows(bundle.tableNames.length, rowCount),
  });
  await yieldToBrowser();

  await seedPerfLabBackend(connection, rowCount);

  if (connection.syncEnabled) {
    await waitForSyncedSeed(client, bundle, rowCount, onProgress);
    return;
  }

  await seedLocalRows(client, bundle, rowCount, scenario.extraColumnCount, onProgress);
}

async function seedPerfLabBackend(connection: ConnectionInput, rowCount: number) {
  await performPerfLabRequest(connection, "/api/perf-lab/seed", {
    method: "POST",
    body: { rowCount },
  });
}

async function waitForSyncedSeed(
  client: PerfLabClient,
  bundle: SyntheticRegistryBundle,
  rowsPerTable: number,
  onProgress: (progress: ProgressState) => void,
) {
  const started = performance.now();
  const totalRows = countSyntheticWorkloadRows(bundle.tableNames.length, rowsPerTable);

  while (performance.now() - started < 30_000) {
    const [rowCounts, overlayBreakdown] = await Promise.all([
      queryRowCounts(client, bundle),
      queryOverlayBreakdown(client, bundle),
    ]);
    const currentRowCount = Object.values(rowCounts).reduce((total, value) => total + value, 0);

    onProgress({
      label: "Waiting for server seed to sync into PGlite across hot tables",
      completed: Math.min(currentRowCount, totalRows),
      total: totalRows,
    });

    if (hasExpectedRowsPerTable(rowCounts, rowsPerTable) && hasOnlySyncedRows(overlayBreakdown)) {
      return;
    }

    await yieldForPoll();
  }

  throw new Error(
    `Timed out waiting for ${formatCount(rowsPerTable)} rows per table (${formatCount(totalRows)} total rows) to sync into ${describeHotTableScope(bundle)}.`,
  );
}

async function waitForFlushConvergence(
  client: PerfLabClient,
  bundle: SyntheticRegistryBundle,
  expectedRowsPerTable: number,
  onProgress: (progress: ProgressState) => void,
) {
  const started = performance.now();
  const totalRows = countSyntheticWorkloadRows(bundle.tableNames.length, expectedRowsPerTable);

  while (performance.now() - started < 30_000) {
    await client.reconcile();

    const [{ mutation }, rowCounts, overlayBreakdown] = await Promise.all([
      client.diagnostics(),
      queryRowCounts(client, bundle),
      queryOverlayBreakdown(client, bundle),
    ]);
    const rowCount = Object.values(rowCounts).reduce((total, value) => total + value, 0);

    onProgress({
      label: "Waiting for Electric convergence across hot tables",
      completed: Math.min(rowCount, totalRows),
      total: totalRows,
    });

    if (
      hasExpectedRowsPerTable(rowCounts, expectedRowsPerTable) &&
      mutation.pendingCount === 0 &&
      mutation.sendingCount === 0 &&
      mutation.failedCount === 0 &&
      mutation.ackedCount === 0 &&
      hasOnlySyncedRows(overlayBreakdown)
    ) {
      return;
    }

    await yieldForPoll();
  }

  throw new Error(`Timed out waiting for Electric convergence across ${describeHotTableScope(bundle)}.`);
}

async function queryRowCounts(client: PerfLabClient, bundle: SyntheticRegistryBundle) {
  const counts = await Promise.all(
    bundle.tableNames.map(async (tableName) => {
      const result = await client.pglite.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${localProjectionName(bundle, tableName)}`,
      );

      return [tableName, Number.parseInt(result.rows[0]?.count ?? "0", 10)] as const;
    }),
  );

  return Object.fromEntries(counts);
}

async function queryOverlayBreakdown(client: PerfLabClient, bundle: SyntheticRegistryBundle) {
  const results = await Promise.all(
    bundle.tableNames.map((tableName) =>
      client.pglite.query<{ overlay_kind: string; count: string }>(
        `
          SELECT overlay_kind, COUNT(*)::text AS count
          FROM ${localProjectionName(bundle, `${tableName}_read_model`)}
          GROUP BY overlay_kind
          ORDER BY overlay_kind
        `,
      ),
    ),
  );

  const countsByKind = new Map<string, number>();

  for (const result of results) {
    for (const row of result.rows) {
      countsByKind.set(row.overlay_kind, (countsByKind.get(row.overlay_kind) ?? 0) + Number.parseInt(row.count, 10));
    }
  }

  return Object.fromEntries(countsByKind.entries());
}

function describeFlushOutcome(
  before: MutationDiagnostics,
  after: MutationDiagnostics,
  convergenceMs: number | null,
  failedMutationSamples: FailedMutationSample[],
) {
  const totalBefore = before.pendingCount + before.sendingCount + before.failedCount;
  const firstFailure = failedMutationSamples[0];

  if (totalBefore === 0) {
    return "No queued mutations";
  }

  if (after.failedCount > 0) {
    const failureSummary = firstFailure
      ? `first failure ${formatFailureReason(firstFailure)}`
      : `${formatCount(after.failedCount)} mutations failed`;

    if (after.ackedCount > 0) {
      return `Mixed ack and failure results; ${failureSummary}`;
    }

    return `Flush failed; ${failureSummary}`;
  }

  if (after.ackedCount > 0 && after.pendingCount === 0 && after.failedCount === 0) {
    return convergenceMs === null
      ? "Acked by write backend"
      : `Acked by write backend and converged via Electric (${convergenceMs.toFixed(2)} ms)`;
  }

  return "Queue churn completed";
}

function summarizeFailedMutations(details: MutationDetail[]): FailedMutationSample[] {
  return details
    .filter((detail) => detail.status === "failed")
    .slice(0, 5)
    .map((detail) => ({
      tableName: detail.tableName,
      entityKeyLabel: formatEntityKey(detail.entityKey),
      mutationId: detail.mutationId,
      mutationSeq: detail.mutationSeq,
      mutationKind: detail.mutationKind,
      attemptCount: detail.attemptCount,
      lastHttpStatus: detail.lastHttpStatus,
      reason: detail.conflictReason ?? detail.lastError ?? "No error details recorded",
      updatedAtUs: detail.updatedAtUs,
    }));
}

function formatFailedMutationSample(sample: FailedMutationSample) {
  const statusText = sample.lastHttpStatus === null ? "HTTP n/a" : `HTTP ${sample.lastHttpStatus}`;
  return `${sample.mutationKind.toUpperCase()} ${sample.tableName}/${sample.entityKeyLabel} · seq ${sample.mutationSeq} · attempt ${sample.attemptCount} · ${statusText} · ${sample.reason} · ${formatUpdatedAtUs(sample.updatedAtUs)}`;
}

function formatFailureReason(sample: FailedMutationSample) {
  const statusText = sample.lastHttpStatus === null ? "HTTP n/a" : `HTTP ${sample.lastHttpStatus}`;
  return `${statusText} on ${sample.tableName}/${sample.entityKeyLabel}: ${sample.reason}`;
}

function formatEntityKey(entityKey: Record<string, string>) {
  const entries = Object.entries(entityKey);

  if (entries.length === 0) {
    return "<unknown>";
  }

  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function formatUpdatedAtUs(updatedAtUs: string) {
  const updatedAtMs = Number(updatedAtUs) / 1000;

  if (!Number.isFinite(updatedAtMs)) {
    return "updated at unknown time";
  }

  return `updated ${new Date(updatedAtMs).toLocaleTimeString()}`;
}

function describeConnection(connection: ConnectionInput) {
  if (connection.mode === "offline") {
    return "offline loopback transport";
  }

  return `live perf-lab backend ${connection.writeUrl} as ${connection.authIdentity}${connection.syncEnabled ? " with Electric echo" : " without Electric echo"}`;
}

function describeConnectionNote(connection: ConnectionInput) {
  if (connection.mode === "offline") {
    return "Offline mode bypasses the dedicated perf-lab backend and measures local journal churn plus transport failure handling only.";
  }

  if (connection.authIdentity === "none") {
    return "The dedicated perf-lab backend enforces demo-auth ownership. Anonymous live runs are expected to fail seeding or writes under RLS.";
  }

  if (connection.syncEnabled) {
    return "The default live path seeds the dedicated backend, syncs those rows into PGlite, flushes local mutations upstream, and waits for the Electric echo to clear overlay state again.";
  }

  return "Live mode without Electric echo still talks to the dedicated perf-lab backend, but it stops before the full downstream convergence phase.";
}

function buildRuntimeDescriptor(scenario: ScenarioInput, connection: ConnectionInput) {
  return JSON.stringify({
    tableCount: scenario.tableCount,
    extraColumnCount: scenario.extraColumnCount,
    connection,
  });
}

function computePercentiles(values: number[]): Percentiles {
  const sorted = [...values].sort((left, right) => left - right);

  return {
    p50: pickPercentile(sorted, 0.5),
    p95: pickPercentile(sorted, 0.95),
    p99: pickPercentile(sorted, 0.99),
  };
}

function pickPercentile(values: number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }

  const index = Math.min(values.length - 1, Math.floor(values.length * percentile));
  return values[index] ?? values[values.length - 1] ?? 0;
}

function createRunId() {
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

function resolveLocalScenarioSchemaName(scenario: ScenarioInput) {
  return (
    findSyntheticPerfLabScenarioDefinition({
      tableCount: Math.max(1, scenario.tableCount),
      extraColumnCount: Math.max(1, scenario.extraColumnCount),
    })?.schemaName ??
    buildSyntheticRegistrySchemaName({
      tableCount: Math.max(1, scenario.tableCount),
      extraColumnCount: Math.max(1, scenario.extraColumnCount),
    })
  );
}

async function truncateLocalPerfLabTables(client: PerfLabClient, bundle: SyntheticRegistryBundle) {
  await truncateLocalPerfLabTablesInDb(client.pglite, bundle);
}

async function truncateLocalPerfLabTablesInDb(db: PerfLabDb, bundle: SyntheticRegistryBundle) {
  const statements = bundle.tableNames.flatMap((tableName) => [
    `DELETE FROM ${localProjectionName(bundle, `${tableName}_overlay`)}`,
    `DELETE FROM ${localProjectionName(bundle, `${tableName}_mutations`)}`,
    `DELETE FROM ${localProjectionName(bundle, tableName)}`,
  ]);

  if (statements.length === 0) {
    return;
  }

  await db.exec(`${statements.join("; ")};`);
}

function localProjectionName(bundle: SyntheticRegistryBundle, objectName: string) {
  const schemaName = getSyncRegistrySchema(bundle.registry);

  if (schemaName === "public") {
    return quoteIdentifier(objectName);
  }

  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(objectName)}`;
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatDuration(value: number | undefined | null) {
  if (value === undefined || value === null) {
    return "-";
  }

  return `${value.toFixed(2)} ms`;
}

function readPositiveIntEnv(name: string, fallback: number) {
  const rawValue = (import.meta.env as Record<string, string | undefined>)[name];

  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function yieldToBrowser() {
  await new Promise<void>((resolve) => {
    window.setTimeout(() => resolve(), 0);
  });
}

async function yieldForPoll() {
  await new Promise<void>((resolve) => {
    window.setTimeout(() => resolve(), 250);
  });
}

function hasOnlySyncedRows(overlayBreakdown: Record<string, number>) {
  const entries = Object.entries(overlayBreakdown);

  if (entries.length === 0) {
    return false;
  }

  return entries.every(([overlayKind]) => overlayKind === "synced");
}

function hasExpectedRowsPerTable(rowCounts: Record<string, number>, expectedRowsPerTable: number) {
  const entries = Object.values(rowCounts);

  if (entries.length === 0) {
    return false;
  }

  return entries.every((count) => count === expectedRowsPerTable);
}

function describeHotTableScope(bundle: SyntheticRegistryBundle | null) {
  if (!bundle || bundle.tableNames.length === 0) {
    return "No tables prepared";
  }

  if (bundle.tableNames.length === 1) {
    return bundle.tableNames[0] ?? "No tables prepared";
  }

  return `${formatCount(bundle.tableNames.length)} hot tables`;
}

async function performPerfLabRequest<TResponse extends Record<string, unknown>>(
  connection: ConnectionInput,
  pathname: string,
  options: {
    method: "POST";
    body: Record<string, number>;
  },
) {
  const authToken = demoAuthTokenByIdentity[connection.authIdentity];
  const response = await fetch(buildPerfLabApiUrl(connection.writeUrl, pathname), {
    method: options.method,
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(options.body),
  });

  if (response.ok) {
    return (await response.json()) as TResponse;
  }

  const payload = (await response.json().catch(() => null)) as { message?: string } | null;
  throw new Error(payload?.message ?? `Perf-lab backend request failed with status ${response.status}`);
}

function buildPerfLabApiUrl(writeUrl: string, pathname: string) {
  const normalizedBase = writeUrl.endsWith("/") ? writeUrl : `${writeUrl}/`;
  return new URL(pathname.replace(/^\//, ""), normalizedBase).toString();
}
