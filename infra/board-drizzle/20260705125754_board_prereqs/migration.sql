-- Board prerequisite functions (board ADR-0005) — must exist BEFORE the schema migration that follows,
-- because that migration's RLS policies reference `board_member_team_ids()` and the cross-team trigger
-- (attached in the later grants+trigger migration) calls `board_block_cross_team_move()`.
--
-- Ordering note: the SQL membership helper reads `team_member`, which the schema migration creates AFTER
-- this one. `check_function_bodies` is disabled for this transaction so the function can be created ahead
-- of its referenced table; its body is parsed/planned at first call (runtime), by which point the schema
-- migration has created `team_member`. (`drizzle-kit migrate` runs each migration file in one
-- transaction, so the `SET LOCAL` covers every statement below.) The trigger function is PL/pgSQL, whose
-- body is never validated at CREATE, so it needs no such treatment.
SET LOCAL check_function_bodies = off;
--> statement-breakpoint
-- Recursion-free membership helper. Every board RLS membership predicate needs "the Teams the caller
-- belongs to" — a read of `team_member`. Inlining that read into team_member's OWN policy (and the
-- issue/message policies that also read it) re-enters team_member's RLS while evaluating it
-- (`42P17 infinite recursion`). SECURITY DEFINER runs as the function owner (a BYPASSRLS superuser at
-- migrate time), so the read does NOT re-trigger RLS — the recursion is broken at the source.
-- `auth.uid()` still resolves the caller's `sub` (session state, unaffected by SECURITY DEFINER).
-- STABLE + a pinned `search_path` (the SECURITY DEFINER hardening rule).
CREATE OR REPLACE FUNCTION board_member_team_ids() RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT team_id FROM team_member WHERE user_id = auth.uid();
$$;
--> statement-breakpoint
-- Cross-team move is Admin-only. An RLS UPDATE policy cannot compare OLD.team_id to NEW.team_id (USING
-- sees only the old row, WITH CHECK only the new), so a BEFORE UPDATE trigger enforces it (attached to
-- `issue` in the grants+trigger migration, once the table exists). The Admin check is the same inline
-- predicate the RLS policies use — reading request.jwt.claims, which the Mutation applier sets before
-- applying a batch. Server authority, never local (the Parity boundary).
CREATE OR REPLACE FUNCTION board_block_cross_team_move() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.team_id IS DISTINCT FROM OLD.team_id
     AND NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(
         coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'roles', '[]'::jsonb)
       ) AS r(role)
       WHERE r.role = 'admin'
     )
  THEN
    RAISE EXCEPTION 'cross-team move requires admin' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
