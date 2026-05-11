import type { TableSpec, TableSpecInput } from "@pgxsinkit/contracts";

import {
  authorRecordSchema,
  createAuthorInputSchema,
  updateAuthorInputSchema,
  type AuthorRecord,
  type CreateAuthorInput,
  type UpdateAuthorInput,
} from "./authors";

export const authorTableSpecInput = {
  name: "authors",
  mode: "readwrite",
  primaryKey: {
    columns: ["id"],
  },
  shape: {
    tableName: "authors",
    shapeKey: "authors",
  },
  routes: {
    basePath: "/api/authors",
    allowBatch: false,
  },
  clientProjection: {
    syncedTable: "authors",
    overlayTable: "author_overlay",
    journalTable: "author_mutations",
    readModel: "author_read_model",
  },
} satisfies TableSpecInput;

export const authorTableSpec = {
  ...authorTableSpecInput,
  schemas: {
    createSchema: createAuthorInputSchema,
    updateSchema: updateAuthorInputSchema,
    recordSchema: authorRecordSchema,
  },
  adapters: {
    toEntityKey: (record) => ({
      id: String(record.id),
    }),
  },
} satisfies TableSpec<CreateAuthorInput, UpdateAuthorInput, AuthorRecord>;
