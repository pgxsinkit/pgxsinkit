// Began as a copy of `@electric-sql/pg-protocol`, itself adapted from node-postgres' `pg-protocol`
// (MIT, © Brian Carlson; ElectricSQL's changes taken under the PostgreSQL License — see NOTICE).
// Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

export const Modes = {
  text: 0,
  binary: 1,
} as const;

export type Mode = (typeof Modes)[keyof typeof Modes];

export type BufferParameter = ArrayBuffer | ArrayBufferView;
