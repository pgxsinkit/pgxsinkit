// Began as a copy of `@electric-sql/pg-protocol`, itself adapted from node-postgres' `pg-protocol`
// (MIT, © Brian Carlson; ElectricSQL's changes taken under the PostgreSQL License — see NOTICE).
// Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

export { Parser, type MessageCallback } from "./parser";
export {
  serialize,
  type BindOpts,
  type ExecOpts,
  type LegalValue,
  type ParseOpts,
  type PortalOpts,
} from "./serializer";
export * as messages from "./messages";
export { Modes, type Mode } from "./types";
