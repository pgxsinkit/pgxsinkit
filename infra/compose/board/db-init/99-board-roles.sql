-- Board demo DB bootstrap — runs AFTER the supabase/postgres image's own init scripts (99- prefix),
-- so the standard Supabase roles + `auth` schema already exist. This file only does what a trimmed
-- self-hosted stack still needs:
--
--   1. Give the service roles a known password so GoTrue (supabase_auth_admin), PostgREST
--      (authenticator), and postgres-meta (supabase_admin) can log in with ${POSTGRES_PASSWORD}.
--   2. Defensively (re)install the `auth.uid()`/`auth.role()`/`auth.jwt()` helpers the toolkit's RLS
--      relies on, so the board does not depend on any one image revision shipping them. Idempotent.
--
-- DEV-ONLY: the board stack is ephemeral and local. These statements are not run against any hosted
-- database (that is the emergent project's domain) — here they bootstrap a throwaway demo cluster.

\set pw `echo "$POSTGRES_PASSWORD"`

ALTER ROLE supabase_admin WITH PASSWORD :'pw';
ALTER ROLE authenticator WITH PASSWORD :'pw';
ALTER ROLE supabase_auth_admin WITH PASSWORD :'pw';

-- PostgREST's login role must be able to assume the request roles.
GRANT anon, authenticated, service_role TO authenticator;

CREATE SCHEMA IF NOT EXISTS auth;

-- The canonical Supabase claim accessors. The applier sets request.jwt.claim.sub /
-- request.jwt.claims per batch (server/src/mutations/plpgsql-apply.ts); these read them back.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )::text
$$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
