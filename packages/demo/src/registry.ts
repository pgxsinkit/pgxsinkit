import { defineSyncRegistry, defineSyncTable, defineTableGovernance } from "@pgxsinkit/contracts";

import { authorTableSpec } from "./author-config";
import { authorsTable, todosTable } from "./schema";
import { todoTableSpec } from "./todo-config";

export const demoSyncRegistry = defineSyncRegistry({
  authors: defineSyncTable({
    table: authorsTable,
    mode: authorTableSpec.mode,
    primaryKey: authorTableSpec.primaryKey,
    shape: authorTableSpec.shape,
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
      rls: {
        enabled: true,
        force: false,
        policies: [
          {
            name: "authors_select_owner_or_admin",
            command: "select",
            as: "permissive",
            roles: ["authenticated"],
            using: "owner_id = auth.uid() OR auth.has_role('admin')",
            usingColumns: ["ownerId"],
          },
          {
            name: "authors_insert_owner_or_admin",
            command: "insert",
            as: "permissive",
            roles: ["authenticated"],
            withCheck: "owner_id = auth.uid() OR auth.has_role('admin')",
            withCheckColumns: ["ownerId"],
          },
          {
            name: "authors_update_owner_or_admin",
            command: "update",
            as: "permissive",
            roles: ["authenticated"],
            using: "owner_id = auth.uid() OR auth.has_role('admin')",
            withCheck: "owner_id = auth.uid() OR auth.has_role('admin')",
            usingColumns: ["ownerId"],
            withCheckColumns: ["ownerId"],
          },
          {
            name: "authors_delete_owner_or_admin",
            command: "delete",
            as: "permissive",
            roles: ["authenticated"],
            using: "owner_id = auth.uid() OR auth.has_role('admin')",
            usingColumns: ["ownerId"],
          },
        ],
      },
    }),
    schemas: authorTableSpec.schemas,
    adapters: authorTableSpec.adapters,
  }),
  todos: defineSyncTable({
    table: todosTable,
    mode: todoTableSpec.mode,
    primaryKey: todoTableSpec.primaryKey,
    shape: todoTableSpec.shape,
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
      rls: {
        enabled: true,
        force: false,
        policies: [
          {
            name: "todos_select_owner_or_admin",
            command: "select",
            as: "permissive",
            roles: ["authenticated"],
            using: "owner_id = auth.uid() OR auth.has_role('admin')",
            usingColumns: ["ownerId"],
          },
          {
            name: "todos_insert_owner_or_admin",
            command: "insert",
            as: "permissive",
            roles: ["authenticated"],
            withCheck: "owner_id = auth.uid() OR auth.has_role('admin')",
            withCheckColumns: ["ownerId"],
          },
          {
            name: "todos_update_owner_or_admin",
            command: "update",
            as: "permissive",
            roles: ["authenticated"],
            using: "owner_id = auth.uid() OR auth.has_role('admin')",
            withCheck: "owner_id = auth.uid() OR auth.has_role('admin')",
            usingColumns: ["ownerId"],
            withCheckColumns: ["ownerId"],
          },
          {
            name: "todos_delete_owner_or_admin",
            command: "delete",
            as: "permissive",
            roles: ["authenticated"],
            using: "owner_id = auth.uid() OR auth.has_role('admin')",
            usingColumns: ["ownerId"],
          },
        ],
      },
    }),
    schemas: todoTableSpec.schemas,
    adapters: todoTableSpec.adapters,
  }),
});
