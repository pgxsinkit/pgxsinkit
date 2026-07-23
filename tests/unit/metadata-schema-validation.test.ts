import { describe, expect, it } from "bun:test";

import { assertValidMetadataSchema, DEFAULT_METADATA_SCHEMA } from "../../packages/client/src/sync/tags";

// The metadata schema name is interpolated RAW into GUC identifier positions (`SET <schema>.syncing`)
// and the `CREATE SCHEMA <schema>` DDL — positions where a double-quoted identifier is not accepted the
// way it is in a table/column position. So the engine validates it at construction (F6): a bare lowercase
// SQL identifier only, rejecting uppercase and exotic names outright.
describe("assertValidMetadataSchema", () => {
  it("accepts the default and other bare lowercase identifiers", () => {
    expect(() => assertValidMetadataSchema(DEFAULT_METADATA_SCHEMA)).not.toThrow();
    expect(() => assertValidMetadataSchema("pgxsinkit")).not.toThrow();
    expect(() => assertValidMetadataSchema("my_app_sync")).not.toThrow();
    expect(() => assertValidMetadataSchema("_private")).not.toThrow();
    expect(() => assertValidMetadataSchema("s1")).not.toThrow();
  });

  it("rejects uppercase, exotic, and injection-shaped names", () => {
    for (const bad of [
      "Public", // uppercase
      "PGXSINKIT", // uppercase
      "1abc", // leading digit
      "foo-bar", // hyphen
      "foo.bar", // qualified
      "foo bar", // whitespace
      'evil"; DROP SCHEMA public; --', // injection attempt
      "", // empty
      "café", // non-ASCII
    ]) {
      expect(() => assertValidMetadataSchema(bad)).toThrow(/Invalid metadataSchema/);
    }
  });
});
