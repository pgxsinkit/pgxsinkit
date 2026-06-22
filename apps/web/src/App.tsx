import { Repl } from "@electric-sql/pglite-repl";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-orm/zod";
import { useEffect, useMemo, useState } from "react";
import { v7 as uuidv7 } from "uuid";

import {
  createBrowserConvergenceTrigger,
  createConvergenceDriver,
  type MutationDetail,
  type MutationDiagnostics,
} from "@pgxsinkit/client";
import { createSyncClientHooks } from "@pgxsinkit/react";
import {
  authorsTable,
  authorsView,
  demoAuthTokenByIdentity,
  todosTable,
  todosView,
  workItemsView,
  workspaceMembersTable,
  workspacesTable,
  type demoMembershipSyncRegistry,
  type DemoAuthIdentity,
} from "@pgxsinkit/schema";

import { loadPGlite, type AppClient } from "./pglite";
import { createReplProxy } from "./repl-proxy";

const createTodoInputSchema = createInsertSchema(todosTable);
const createAuthorInputSchema = createInsertSchema(authorsTable);

const { SyncClientProvider, useSyncClient, useLiveDrizzleRows } =
  createSyncClientHooks<typeof demoMembershipSyncRegistry>();

const identityOptions: { value: DemoAuthIdentity; label: string }[] = [
  { value: "none", label: "No user" },
  { value: "user1", label: "User 1 — Aurora manager" },
  { value: "user2", label: "User 2 — Aurora member" },
  { value: "user3", label: "User 3 — Aurora member (muted)" },
  { value: "user4", label: "User 4 — Borealis manager" },
  { value: "user5", label: "User 5 — Borealis member" },
  { value: "admin", label: "Admin" },
];

const validIdentities = new Set<string>(identityOptions.map((option) => option.value));

const emptyForm = {
  title: "",
  description: "",
  status: "todo",
  priority: "medium",
} as const;

type SyncPhase = "booting" | "syncing" | "ready";
const identityStorageKey = "pgxsinkit-demo-identity";

export function App() {
  const [authIdentity] = useState<DemoAuthIdentity>(() => {
    const raw = window.localStorage.getItem(identityStorageKey);
    if (raw && validIdentities.has(raw)) {
      return raw as DemoAuthIdentity;
    }

    return "user1";
  });
  const [client, setClient] = useState<AppClient>();
  const [syncPhase, setSyncPhase] = useState<SyncPhase>("booting");
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    let disposeClient: (() => Promise<void>) | null = null;

    setClient(undefined);
    setSyncPhase("booting");
    setBootstrapError(null);

    void loadPGlite({
      identity: authIdentity,
      getAuthToken: async () => {
        return demoAuthTokenByIdentity[authIdentity] ?? undefined;
      },
    })
      .then(({ client, initialSyncDone, dispose }) => {
        disposeClient = dispose;

        if (!isMounted) {
          void dispose();
          return;
        }

        setClient(client);
        setSyncPhase("syncing");

        void initialSyncDone.then(() => {
          if (isMounted) {
            setSyncPhase("ready");
          }
        });
      })
      .catch((reason: unknown) => {
        if (isMounted) {
          setBootstrapError(reason instanceof Error ? reason.message : "Failed to start local PGlite");
        }
      });

    return () => {
      isMounted = false;
      if (disposeClient) {
        void disposeClient();
      }
    };
  }, [authIdentity]);

  function handleIdentityChange(nextIdentity: DemoAuthIdentity) {
    if (nextIdentity === authIdentity) {
      return;
    }

    window.localStorage.setItem(identityStorageKey, nextIdentity);
    window.location.reload();
  }

  if (bootstrapError) {
    return (
      <main className="shell">
        <p className="error">{bootstrapError}</p>
      </main>
    );
  }

  if (!client) {
    return (
      <main className="shell">
        <section className="hero">
          <p className="eyebrow">ElectricSQL / PGlite / PostgreSQL</p>
          <h1>pgxsinkit</h1>
          <p className="lede">Booting local PGlite and preparing the synced read model.</p>
        </section>
      </main>
    );
  }

  return (
    <SyncClientProvider client={client}>
      <TodoApp syncPhase={syncPhase} authIdentity={authIdentity} onAuthIdentityChange={handleIdentityChange} />
    </SyncClientProvider>
  );
}

type JournalRow = MutationDetail;

type Tab = "app" | "repl";

function TodoApp({
  syncPhase,
  authIdentity,
  onAuthIdentityChange,
}: {
  syncPhase: SyncPhase;
  authIdentity: DemoAuthIdentity;
  onAuthIdentityChange: (identity: DemoAuthIdentity) => void;
}) {
  const client = useSyncClient();
  const db = client.pglite;
  const [tab, setTab] = useState<Tab>("app");
  const replProxy = useMemo(() => createReplProxy(db), [db]);
  const [journalRows, setJournalRows] = useState<JournalRow[]>([]);
  const [authorName, setAuthorName] = useState<string>("");
  const [title, setTitle] = useState<string>(emptyForm.title);
  const [description, setDescription] = useState<string>(emptyForm.description);
  const [authorId, setAuthorId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [mutationStats, setMutationStats] = useState<MutationDiagnostics>({
    pendingCount: 0,
    sendingCount: 0,
    failedCount: 0,
    quarantinedCount: 0,
    ackedCount: 0,
  });
  const { rows: rawTodoRows } = useLiveDrizzleRows(
    (c) =>
      c.drizzle
        .select({
          id: todosView.id,
          title: todosView.title,
          description: todosView.description,
          authorId: todosView.authorId,
          status: todosView.status,
          priority: todosView.priority,
          overlayKind: todosView.overlay_kind,
          localUpdatedAtUs: sql<string>`${todosView.local_updated_at_us}::text`,
          createdAtUs: todosView.createdAtUs,
          updatedAtUs: todosView.updatedAtUs,
        })
        .from(todosView)
        .orderBy(todosView.createdAtUs),
    [],
  );
  const { rows: rawAuthorRows } = useLiveDrizzleRows(
    (c) =>
      c.drizzle
        .select({
          id: authorsView.id,
          name: authorsView.name,
          createdAtUs: authorsView.createdAtUs,
          updatedAtUs: authorsView.updatedAtUs,
        })
        .from(authorsView)
        .orderBy(authorsView.createdAtUs),
    [],
  );
  // Membership scenarios: each of these arrives filtered to the current identity by the proxy.
  // workspaces + workspace_members are readonly synced tables (no overlay); work_items is the
  // overlay-merged read model.
  const { rows: workspaceRows } = useLiveDrizzleRows(
    (c) =>
      c.drizzle
        .select({ id: workspacesTable.id, name: workspacesTable.name, locked: workspacesTable.locked })
        .from(workspacesTable)
        .orderBy(workspacesTable.name),
    [],
  );
  const { rows: membershipRows } = useLiveDrizzleRows(
    (c) =>
      c.drizzle
        .select({
          workspaceId: workspaceMembersTable.workspaceId,
          role: workspaceMembersTable.role,
          muted: workspaceMembersTable.muted,
        })
        .from(workspaceMembersTable),
    [],
  );
  const { rows: workItemRows } = useLiveDrizzleRows(
    (c) =>
      c.drizzle
        .select({
          id: workItemsView.id,
          workspaceId: workItemsView.workspaceId,
          body: workItemsView.body,
          hidden: workItemsView.hidden,
          ownerId: workItemsView.ownerId,
        })
        .from(workItemsView)
        .orderBy(workItemsView.createdAtUs),
    [],
  );
  const [workItemBody, setWorkItemBody] = useState<string>("");
  const [workItemWorkspaceId, setWorkItemWorkspaceId] = useState<string>("");

  const membershipByWorkspace = new Map(membershipRows.map((row) => [row.workspaceId, row]));
  const workspaceNameById = new Map(workspaceRows.map((row) => [row.id, row.name ?? row.id]));

  useEffect(() => {
    setWorkItemWorkspaceId((prev) => (prev.length === 0 && workspaceRows[0] ? workspaceRows[0].id : prev));
  }, [workspaceRows]);

  useEffect(() => {
    let isDisposed = false;

    async function refreshDisplay() {
      if (isDisposed) {
        return;
      }

      const [{ mutation }, mutationJournal] = await Promise.all([client.diagnostics(), client.readMutationDetails()]);

      if (!isDisposed) {
        setMutationStats(mutation);
        setJournalRows(sortJournalRows(mutationJournal));
      }
    }

    // The opt-in convergence driver (ADR-0005) owns the flush/reconcile/retry loop on the
    // browser schedule; the component just refreshes its diagnostics view after each pass.
    const driver = createConvergenceDriver({
      client,
      trigger: createBrowserConvergenceTrigger(),
      onPass: (error) => {
        if (error && !isDisposed) {
          setError(error instanceof Error ? error.message : "Failed to process local writes");
        }
        void refreshDisplay();
      },
    });

    driver.start();

    return () => {
      isDisposed = true;
      // stop() now drains the in-flight pass; the effect cleanup is sync, so fire-and-forget.
      void driver.stop();
    };
  }, [client]);

  const authors = rawAuthorRows;

  const todos = useMemo(
    () => rawTodoRows.map(({ overlayKind: _overlayKind, localUpdatedAtUs: _localUpdatedAtUs, ...todo }) => todo),
    [rawTodoRows],
  );

  useEffect(() => {
    setAuthorId((prev) => (prev.length === 0 && authors[0] ? authors[0].id : prev));
  }, [authors]);

  const mutationByTodoId = new Map<string, JournalRow>();
  const authorById = new Map(authors.map((author) => [author.id, author]));
  const selectedAuthor = authorId.length > 0 ? authorById.get(authorId) : undefined;

  for (const entry of journalRows) {
    if (entry.tableName !== "todos") {
      continue;
    }

    const todoId = entry.entityKey["id"];
    if (!todoId) {
      continue;
    }

    const current = mutationByTodoId.get(todoId);

    if (!current || entry.mutationSeq > current.mutationSeq) {
      mutationByTodoId.set(todoId, entry);
    }
  }

  async function refreshMutationState() {
    const [{ mutation }, mutationJournal] = await Promise.all([client.diagnostics(), client.readMutationDetails()]);

    setMutationStats(mutation);
    setJournalRows(sortJournalRows(mutationJournal));
  }

  async function handleSubmit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const parsed = createTodoInputSchema.safeParse({
      id: uuidv7(),
      title,
      description: description.length === 0 ? null : description,
      authorId,
      status: emptyForm.status,
      priority: emptyForm.priority,
    });

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }

    try {
      await client.tables.todos.create(parsed.data);
      await client.flush();
      await refreshMutationState();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to queue local write");
      return;
    }

    setTitle("");
    setDescription("");
  }

  async function handleCreateAuthor(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const parsed = createAuthorInputSchema.safeParse({
      id: uuidv7(),
      name: authorName,
    });

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid author input");
      return;
    }

    try {
      await client.tables.authors.create(parsed.data);
      setAuthorId(parsed.data.id);
      await client.flush();
      await refreshMutationState();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to queue local write");
      return;
    }

    setAuthorName("");
  }

  async function handleCreateWorkItem(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (workItemWorkspaceId.length === 0) {
      setError("Pick a workspace before posting a work item.");
      return;
    }

    try {
      await client.tables.work_items.create({
        id: uuidv7(),
        workspaceId: workItemWorkspaceId,
        body: workItemBody,
      });
      await client.flush();
      await refreshMutationState();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to queue work item");
      return;
    }

    setWorkItemBody("");
  }

  async function processQueuedWork(action: () => Promise<void>) {
    setError(null);

    try {
      await action();
      await client.flush();
      await refreshMutationState();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to queue local write");
    }
  }

  function handleToggleStatus(todo: (typeof todos)[number]) {
    const nextStatus = todo.status === "done" ? "todo" : "done";
    void processQueuedWork(() => client.tables.todos.update({ id: todo.id }, { status: nextStatus }));
  }

  function handleDelete(todo: (typeof todos)[number]) {
    void processQueuedWork(() => client.tables.todos.delete({ id: todo.id }));
  }

  function handleRetryFailedMutations() {
    void processQueuedWork(async () => {
      await client.retryFailed();
    });
  }

  return (
    <main className="shell" data-tab={tab}>
      <nav className="tab-nav">
        <button
          type="button"
          className={`tab-btn${tab === "app" ? " tab-btn--active" : ""}`}
          onClick={() => setTab("app")}
        >
          App
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
        <Repl pg={replProxy} border theme="auto" showTime />
      </section>

      <div style={tab === "app" ? undefined : { display: "none" }}>
        <section className="hero">
          <p className="eyebrow">ElectricSQL / PGlite / PostgreSQL</p>
          <h1>pgxsinkit</h1>
          <p className="lede">
            Reads come from a persistent local PGlite database that syncs from Electric. Creates now land in a local
            overlay and mutation journal first, then flush through the API and clear only after the synced echo has
            converged.
          </p>
          <div className="status-row">
            <span className={`status-pill status-${syncPhase}`}>
              {syncPhase === "booting" && "Booting local PGlite"}
              {syncPhase === "syncing" && "Syncing from Electric"}
              {syncPhase === "ready" && "Reading from local PGlite"}
            </span>
            <label className="identity-picker">
              <span>Identity</span>
              <select
                value={authIdentity}
                onChange={(event) => onAuthIdentityChange(event.target.value as DemoAuthIdentity)}
              >
                {identityOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="status-pill status-journal">
              {mutationStats.pendingCount} pending / {mutationStats.failedCount} failed / {mutationStats.ackedCount}{" "}
              awaiting echo
            </span>
            {mutationStats.failedCount > 0 ? (
              <button className="pill-action" type="button" onClick={handleRetryFailedMutations}>
                Retry failed writes
              </button>
            ) : null}
          </div>
        </section>

        <section className="panel">
          <div className="journal-header">
            <h2>Workspaces (membership-synced)</h2>
            <p className="muted">
              These rows arrive filtered to your identity: you sync the workspaces you belong to, your own membership,
              and the work items visible to you. Switch identity to watch fan-out, manager-only hidden rows, and
              lock/mute write-gating change.
            </p>
          </div>
          <div className="grid">
            <div className="insight">
              <h2>Your workspaces</h2>
              <ul className="todo-list">
                {workspaceRows.map((workspace) => {
                  const membership = membershipByWorkspace.get(workspace.id);
                  return (
                    <li key={workspace.id}>
                      <strong>{workspace.name ?? workspace.id}</strong>
                      <small>{workspace.locked ? "🔒 locked" : "open"}</small>
                      {membership ? (
                        <small>
                          you are {membership.role}
                          {membership.muted ? " · muted" : ""}
                        </small>
                      ) : null}
                    </li>
                  );
                })}
                {workspaceRows.length === 0 ? <li>No workspaces synced for this identity.</li> : null}
              </ul>
            </div>

            <div className="insight">
              <h2>Visible work items</h2>
              <ul className="todo-list">
                {workItemRows.map((item) => (
                  <li key={item.id}>
                    <strong>{workspaceNameById.get(item.workspaceId) ?? item.workspaceId}</strong>
                    <p>{item.body}</p>
                    <small>{item.hidden ? "🙈 hidden — managers only" : "visible to all members"}</small>
                  </li>
                ))}
                {workItemRows.length === 0 ? <li>No work items visible to this identity.</li> : null}
              </ul>
            </div>

            <form className="composer" onSubmit={handleCreateWorkItem}>
              <h2>Post a work item</h2>
              <label>
                <span>Workspace</span>
                <select value={workItemWorkspaceId} onChange={(event) => setWorkItemWorkspaceId(event.target.value)}>
                  <option value="">Select a workspace…</option>
                  {workspaceRows.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name ?? workspace.id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Body</span>
                <textarea rows={3} value={workItemBody} onChange={(event) => setWorkItemBody(event.target.value)} />
              </label>
              <button type="submit">Queue work item</button>
              <p className="muted">
                A locked workspace accepts writes only from its manager; a muted member is rejected even in an open
                workspace. Rejections surface as failed mutations in the journal below.
              </p>
            </form>
          </div>
        </section>

        <section className="panel grid">
          <form className="composer" onSubmit={handleSubmit}>
            <h2>Create todo</h2>
            <label>
              <span>Title</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label>
              <span>Author</span>
              <select value={authorId} onChange={(event) => setAuthorId(event.target.value)}>
                {authors.map((author) => (
                  <option key={author.id} value={author.id}>
                    {author?.name ?? author.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Description</span>
              <textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} />
            </label>
            <button type="submit">Queue local create</button>
            <p className="muted">
              The todo list below is sourced from local PGlite and merged with local pending writes.
            </p>
            {authors.length === 0 ? (
              <p className="muted">No synced authors yet. Seed an author before creating child todos.</p>
            ) : selectedAuthor === undefined && authorId.length > 0 ? (
              <p className="muted">
                Selected author is still pending sync. Wait for the author row to land before creating a todo.
              </p>
            ) : null}
            {error ? <p className="error">{error}</p> : null}
          </form>

          <div className="insight">
            <h2>Authors</h2>
            <form className="composer" onSubmit={handleCreateAuthor}>
              <label>
                <span>Name</span>
                <input value={authorName} onChange={(event) => setAuthorName(event.target.value)} />
              </label>
              <button type="submit">Queue local author create</button>
              <p className="muted">
                Author creates flush before todo mutations, but client-side parent/child integrity is still not
                enforced.
              </p>
            </form>
            <ul className="todo-list">
              {authors.map((author) => (
                <li key={author.id}>
                  <strong>{author?.name ?? author.id}</strong>
                  <small>{author.id}</small>
                </li>
              ))}
              {authors.length === 0 ? <li>No synced authors yet.</li> : null}
            </ul>
          </div>

          <div className="insight">
            <h2>Current todos</h2>
            <ul className="todo-list">
              {todos.map((todo) => (
                <li key={todo.id}>
                  <strong>{todo.title}</strong>
                  <p>{todo.description ?? "No description"}</p>
                  <small>author: {authorById.get(todo.authorId)?.name ?? todo.authorId}</small>
                  <small>
                    {todo.status} / {todo.priority}
                  </small>
                  <small>{todo.updatedAtUs}</small>
                  <div className="todo-actions">
                    <button type="button" onClick={() => handleToggleStatus(todo)}>
                      {todo.status === "done" ? "Reopen" : "Mark done"}
                    </button>
                    <button className="danger-button" type="button" onClick={() => handleDelete(todo)}>
                      Delete
                    </button>
                  </div>
                  {mutationByTodoId.has(todo.id) ? (
                    <small>
                      Latest queued mutation: {mutationByTodoId.get(todo.id)?.mutationKind} #
                      {mutationByTodoId.get(todo.id)?.mutationSeq}
                    </small>
                  ) : null}
                </li>
              ))}
              {todos.length === 0 ? <li>No synced todos yet.</li> : null}
            </ul>
          </div>
        </section>

        <section className="panel journal-panel">
          <div className="journal-header">
            <h2>Mutation journal</h2>
            <p className="muted">
              This is the local durable write queue, including retry backoff timing and captured conflict information.
            </p>
          </div>
          <ul className="journal-list">
            {journalRows.map((row) => (
              <li key={row.mutationId} className="journal-item">
                <div className="journal-main">
                  <strong>
                    {row.tableName} / {row.mutationKind} / {row.status} / #{row.mutationSeq}
                  </strong>
                  <small>{row.entityKey["id"] ?? JSON.stringify(row.entityKey)}</small>
                </div>
                <small>attempts: {row.attemptCount}</small>
                <small>next retry: {row.nextRetryAtUs ?? "ready now"}</small>
                <small>http: {row.lastHttpStatus ?? "n/a"}</small>
                <small>server updated_at_us: {row.serverUpdatedAtUs ?? "n/a"}</small>
                <small>conflict: {row.conflictReason ?? "none"}</small>
                <small>last error: {row.lastError ?? "none"}</small>
              </li>
            ))}
            {journalRows.length === 0 ? <li className="journal-item">No queued or recent mutations.</li> : null}
          </ul>
        </section>
      </div>
    </main>
  );
}

function sortJournalRows(rows: JournalRow[]) {
  return [...rows].sort((left, right) => Number(BigInt(right.updatedAtUs) - BigInt(left.updatedAtUs)));
}
