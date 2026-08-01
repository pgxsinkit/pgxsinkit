import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { PGlite } from "@electric-sql/pglite";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, pgRole, pgTable, uuid, type AnyPgTable } from "drizzle-orm/pg-core";

import { BOARD_ADMIN_PREDICATE_SQL } from "@pgxsinkit/board-schema";
import {
  buildSupabaseGrantScopeNativePolicies,
  buildSupabaseOwnerOrAdminNativePolicies,
  buildSupabaseOwnerOrAdminPredicateSqlText,
  resolveGrantScopeAccess,
  resolveOwnerOrAdminAccess,
  type GrantScopeAccessOptions,
  type JwtClaims,
} from "@pgxsinkit/contracts";

import { createTablesFromSchema } from "../support/drizzle";
import { closeOpenTestPGlites, createFreshTestPGlite } from "../support/pglite";

// A signed JWT is not a SCHEMA-checked one: a custom-access-token-hook rollout (or a plain claim-schema
// mistake) can mint `roles: "admin"` instead of `["admin"]`, or an object where an array belongs. The JS
// read-path mirrors treat such a claim as conferring nothing and never throw; the SQL twins must reach
// the SAME verdict — a present-but-non-array claim used to reach `jsonb_array_elements(_text)` and raise
// "cannot extract elements from a scalar/object", turning every governed write into an RLS EXECUTION
// error instead of a clean deny.
//
// These tests execute the real policies (built by the shipped builders, installed as CREATE POLICY DDL)
// against the embedded PGlite engine. RLS is only enforced for a non-owner, non-superuser role, so the
// session switches to `app_user` after seeding: the seed rows go in as the table owner (who bypasses
// RLS), every assertion below runs as the governed role.

const appRole = pgRole("app_user");

const OWNER = "10000000-0000-4000-8000-000000000001";
const STRANGER = "10000000-0000-4000-8000-000000000002";
const OFFERING = "20000000-0000-4000-8000-00000000000a";
const OTHER_OFFERING = "20000000-0000-4000-8000-00000000000b";

const ownedRows = pgTable("mc_projects", { id: uuid("id").primaryKey(), ownerId: uuid("owner_id") }, (t) =>
  buildSupabaseOwnerOrAdminNativePolicies({ role: appRole, ownerColumn: t.ownerId }),
);

const scopeDeclaration = { scopeKind: "offering", roleValues: ["teacher"] } satisfies GrantScopeAccessOptions;
const bypassDeclaration = {
  ...scopeDeclaration,
  bypass: { roleValues: ["platform_admin"] },
} satisfies GrantScopeAccessOptions;

const scopedRows = pgTable(
  "mc_enrolments",
  { id: uuid("id").primaryKey(), offeringId: uuid("offering_id").notNull() },
  (t) => buildSupabaseGrantScopeNativePolicies({ role: appRole, scopeColumn: t.offeringId, ...scopeDeclaration }),
);

const bypassRows = pgTable(
  "mc_bypass_enrolments",
  { id: uuid("id").primaryKey(), offeringId: uuid("offering_id").notNull() },
  (t) => buildSupabaseGrantScopeNativePolicies({ role: appRole, scopeColumn: t.offeringId, ...bypassDeclaration }),
);

// The claim shapes a JS mirror already refuses: present, signed, and NOT an array.
const malformedRoles: Record<string, unknown> = {
  "scalar roles": "admin",
  "object roles": { admin: true },
};
const malformedGrants: Record<string, unknown> = {
  "scalar grants": "teacher",
  "object grants": { role: "teacher", scope: { kind: "offering", offeringId: OFFERING } },
};

function roleClaims(subject: string, roles: unknown): JwtClaims {
  return { sub: subject, app_metadata: { roles } } as JwtClaims;
}

function grantClaims(subject: string, grants: unknown): JwtClaims {
  return { sub: subject, app_metadata: { authorization: { grants } } } as JwtClaims;
}

// The DDL text of one command's predicate, as CREATE POLICY would carry it.
const dialect = new PgDialect();
function renderPolicyText(table: AnyPgTable, command: string): string {
  const policy = getTableConfig(table).policies.find((entry) => entry.for === command) as
    | { using?: SQL; withCheck?: SQL }
    | undefined;
  const fragment = policy?.using ?? policy?.withCheck;
  return fragment ? dialect.sqlToQuery(fragment).sql : "";
}

let db: PGlite;

async function useClaims(claims: JwtClaims): Promise<void> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
}

async function visibleIds(table: string): Promise<string[]> {
  const result = await db.query<{ id: string }>(`select id from ${table} order by id`);
  return result.rows.map((row) => row.id);
}

/** The error a statement raised, or null when it succeeded — so a DENY and an ERROR are distinguishable. */
async function errorFrom(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

beforeAll(async () => {
  db = await createFreshTestPGlite();
  await db.exec(`create role app_user;`);
  await createTablesFromSchema(db, { ownedRows, scopedRows, bypassRows });

  // The board's hand-rolled Admin predicate (packages/board-schema/src/policies.ts) carries the same
  // guard; a SELECT-only policy over a throwaway table exercises the exact string the board ships.
  await db.exec(`
    create table mc_board_rows (id uuid primary key);
    alter table mc_board_rows enable row level security;
    create policy mc_board_rows_select on mc_board_rows as permissive for select to app_user
      using (${BOARD_ADMIN_PREDICATE_SQL});
  `);

  await db.query(`insert into mc_projects (id, owner_id) values ($1, $1), ($2, $2)`, [OWNER, STRANGER]);
  await db.query(`insert into mc_enrolments (id, offering_id) values ($1, $1)`, [OFFERING]);
  await db.query(`insert into mc_bypass_enrolments (id, offering_id) values ($1, $1), ($2, $2)`, [
    OFFERING,
    OTHER_OFFERING,
  ]);
  await db.query(`insert into mc_board_rows (id) values ($1)`, [OWNER]);

  await db.exec(`
    grant select, insert, update, delete on mc_projects, mc_enrolments, mc_bypass_enrolments, mc_board_rows to app_user;
    set role app_user;
  `);
});

afterAll(closeOpenTestPGlites);

describe("malformed claim arrays deny in RLS instead of erroring (owner-or-admin)", () => {
  it("grants the admin bypass on a well-formed roles array (the guard leaves the happy path alone)", async () => {
    await useClaims(roleClaims(STRANGER, ["admin"]));
    expect(await visibleIds("mc_projects")).toEqual([OWNER, STRANGER]);
  });

  for (const [label, roles] of Object.entries(malformedRoles)) {
    it(`denies the admin bypass for ${label} — no error, and the owner branch still works`, async () => {
      const claims = roleClaims(OWNER, roles);

      // The JS mirror confers nothing (ratified semantics)…
      expect(resolveOwnerOrAdminAccess(claims)).toEqual({ admin: false, subject: OWNER });

      // …and the policy agrees: the caller sees their OWN row and nothing else, rather than raising
      // "cannot extract elements from a scalar/object".
      await useClaims(claims);
      expect(await visibleIds("mc_projects")).toEqual([OWNER]);
    });

    it(`rejects a write by POLICY, not by execution error, for ${label}`, async () => {
      await useClaims(roleClaims(STRANGER, roles));

      const message = await errorFrom(() =>
        db.query(`insert into mc_projects (id, owner_id) values (gen_random_uuid(), $1)`, [OWNER]),
      );

      expect(message).toContain("row-level security policy");
      expect(message).not.toContain("cannot extract elements");
    });
  }

  it("denies the board's hand-rolled Admin predicate the same way", async () => {
    await useClaims(roleClaims(OWNER, ["admin"]));
    expect(await visibleIds("mc_board_rows")).toEqual([OWNER]);

    for (const roles of Object.values(malformedRoles)) {
      await useClaims(roleClaims(OWNER, roles));
      expect(await visibleIds("mc_board_rows")).toEqual([]);
    }
  });
});

describe("malformed claim arrays deny in RLS instead of erroring (grant scope)", () => {
  const teacherGrant = { role: "teacher", scope: { kind: "offering", offeringId: OFFERING } };
  const bypassGrant = { role: "platform_admin", scope: { kind: "platform" } };

  it("still resolves a well-formed grant set and bypass grant", async () => {
    await useClaims(grantClaims(OWNER, [teacherGrant]));
    expect(await visibleIds("mc_enrolments")).toEqual([OFFERING]);

    await useClaims(grantClaims(OWNER, [bypassGrant]));
    expect(await visibleIds("mc_enrolments")).toEqual([]); // no bypass declared on this table
    expect(await visibleIds("mc_bypass_enrolments")).toEqual([OFFERING, OTHER_OFFERING]);
  });

  for (const [label, grants] of Object.entries(malformedGrants)) {
    it(`sees no rows for ${label}, on the default form and the bypass form alike`, async () => {
      const claims = grantClaims(OWNER, grants);

      // Both JS mirrors confer nothing…
      expect(resolveGrantScopeAccess(claims, scopeDeclaration)).toEqual({ bypass: false, ids: [] });
      expect(resolveGrantScopeAccess(claims, bypassDeclaration)).toEqual({ bypass: false, ids: [] });

      // …and both policies deny rather than raising an execution error.
      await useClaims(claims);
      expect(await visibleIds("mc_enrolments")).toEqual([]);
      expect(await visibleIds("mc_bypass_enrolments")).toEqual([]);
    });

    it(`rejects a write by POLICY, not by execution error, for ${label}`, async () => {
      await useClaims(grantClaims(OWNER, grants));

      for (const table of ["mc_enrolments", "mc_bypass_enrolments"]) {
        const message = await errorFrom(() =>
          db.query(`insert into ${table} (id, offering_id) values (gen_random_uuid(), $1)`, [OFFERING]),
        );

        expect(message).toContain("row-level security policy");
        expect(message).not.toContain("cannot extract elements");
      }
    });
  }
});

describe("every claim-array expansion in a shipped predicate is guarded", () => {
  // The rendered-text half of the same contract: each builder that expands a claim array must wrap the
  // extraction in the `case jsonb_typeof(…) when 'array' …` guard. A new expansion site that skips it
  // would reintroduce SPEC-D732-001 (a signed-but-malformed claim erroring the whole statement).
  const guarded = (text: string, expansions: number) => {
    const guards = text.match(/case jsonb_typeof\(/g) ?? [];
    expect(guards).toHaveLength(expansions);
    expect(text).toContain(`else '[]'::jsonb end`);
  };

  it("guards the owner-or-admin roles array (text builder and native policies)", () => {
    guarded(buildSupabaseOwnerOrAdminPredicateSqlText(), 1);

    const governed = pgTable("guarded_projects", { id: uuid("id").primaryKey(), ownerId: uuid("owner_id") }, (t) =>
      buildSupabaseOwnerOrAdminNativePolicies({ role: appRole, ownerColumn: t.ownerId }),
    );
    guarded(renderPolicyText(governed, "select"), 1);
  });

  it("guards the grants array in the default, naive, and bypass grant-scope forms", () => {
    const build = (extra: Record<string, unknown>) =>
      renderPolicyText(
        pgTable("guarded_enrolments", { id: uuid("id").primaryKey(), offeringId: uuid("offering_id").notNull() }, (t) =>
          buildSupabaseGrantScopeNativePolicies({
            role: appRole,
            scopeColumn: t.offeringId,
            ...scopeDeclaration,
            ...extra,
          }),
        ),
        "select",
      );

    guarded(build({}), 1);
    guarded(build({ naive: true }), 1);
    // The bypass EXISTS expands the grants array a second time — it needs its own guard.
    guarded(build({ bypass: bypassDeclaration.bypass }), 2);
    guarded(build({ naive: true, bypass: bypassDeclaration.bypass }), 2);
  });

  it("guards the board's hand-rolled Admin predicate", () => {
    guarded(BOARD_ADMIN_PREDICATE_SQL, 1);
  });
});
