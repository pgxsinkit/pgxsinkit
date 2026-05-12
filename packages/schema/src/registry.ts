import { defineSyncRegistry, defineSyncTable, defineTableGovernance } from "@pgxsinkit/contracts";

import { authorTableSpec } from "./author-config";
import { authorsTable, authorsView, todosTable, todosView } from "./schema";
import { todoTableSpec } from "./todo-config";

export const demoSyncRegistry = defineSyncRegistry({
  authors: defineSyncTable({
    table: authorsTable,
    view: authorsView,
    mode: authorTableSpec.mode,
    primaryKey: authorTableSpec.primaryKey,
    shape: {
      ...authorTableSpec.shape,
      rowFilter: { ownership: { column: "owner_id" } },
    },
    routes: authorTableSpec.routes,
    clientProjection: authorTableSpec.clientProjection,
    governance: defineTableGovernance(authorsTable, {
      managedFields: [
        {
          column: "ownerId",
          applyOn: ["create"],
          strategy: "authUid",
        },
        {
          column: "modifiedBy",
          applyOn: ["create", "update"],
          strategy: "authUid",
        },
        {
          column: "createdAtUs",
          applyOn: ["create"],
          strategy: "nowMicroseconds",
        },
        {
          column: "updatedAtUs",
          applyOn: ["create", "update"],
          strategy: "nowMicroseconds",
        },
      ],
    }),
    schemas: authorTableSpec.schemas,
    adapters: authorTableSpec.adapters,
  }),
  todos: defineSyncTable({
    table: todosTable,
    view: todosView,
    mode: todoTableSpec.mode,
    primaryKey: todoTableSpec.primaryKey,
    shape: {
      ...todoTableSpec.shape,
      rowFilter: { ownership: { column: "owner_id" } },
    },
    routes: todoTableSpec.routes,
    clientProjection: todoTableSpec.clientProjection,
    governance: defineTableGovernance(todosTable, {
      deferrableConstraints: [
        {
          constraintName: "todos_author_id_authors_id_fkey",
          columns: ["authorId"],
          initiallyDeferred: false,
        },
      ],
      managedFields: [
        {
          column: "ownerId",
          applyOn: ["create"],
          strategy: "authUid",
        },
        {
          column: "modifiedBy",
          applyOn: ["create", "update"],
          strategy: "authUid",
        },
        {
          column: "createdAtUs",
          applyOn: ["create"],
          strategy: "nowMicroseconds",
        },
        {
          column: "updatedAtUs",
          applyOn: ["create", "update"],
          strategy: "nowMicroseconds",
        },
      ],
    }),
    schemas: todoTableSpec.schemas,
    adapters: todoTableSpec.adapters,
  }),
});
