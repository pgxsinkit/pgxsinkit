import { describe, expect, it } from "bun:test";

import { isManagedFieldGuarded, type ManagedFieldApplyOn } from "@pgxsinkit/contracts";

// The guard rule ("which managed fields are SERVER-OWNED for an operation") has one definition:
// `isManagedFieldGuarded`. The write route's `getGuardedManagedFields`, the client's
// `stripManagedFields`, and the apply-function generator's candidate-column exclusions all derive from
// it, and `ManagedFieldColumnKeys` is its type-level twin. These cases pin the rule itself; the
// per-surface behaviour pins live in update-managed-field-guard.test.ts, client-managed-field-strip.test.ts,
// and plpgsql-apply.test.ts.

const field = (applyOn: ManagedFieldApplyOn[]) => ({ applyOn });

describe("isManagedFieldGuarded", () => {
  it("guards a create-managed field on create, and leaves an update-only one settable there", () => {
    expect(isManagedFieldGuarded(field(["create"]), "create")).toBe(true);
    expect(isManagedFieldGuarded(field(["create", "update"]), "create")).toBe(true);
    // Managed on update only: nothing stamps it at birth, so a create payload may carry it.
    expect(isManagedFieldGuarded(field(["update"]), "create")).toBe(false);
  });

  it("guards EVERY managed field on update, create-only ones included", () => {
    // The load-bearing case: a create-only field is stamped at birth and inert on update (the generated
    // apply function offers no UPDATE SET candidate for it), so it is never a settable update key.
    expect(isManagedFieldGuarded(field(["create"]), "update")).toBe(true);
    expect(isManagedFieldGuarded(field(["update"]), "update")).toBe(true);
    expect(isManagedFieldGuarded(field(["create", "update"]), "update")).toBe(true);
  });

  it("guards nothing on delete — a delete carries no payload", () => {
    expect(isManagedFieldGuarded(field(["create"]), "delete")).toBe(false);
    expect(isManagedFieldGuarded(field(["update"]), "delete")).toBe(false);
    expect(isManagedFieldGuarded(field(["create", "update"]), "delete")).toBe(false);
  });
});
