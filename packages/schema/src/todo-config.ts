import type { TableSpec, TableSpecInput } from "@pgxsinkit/contracts";

import {
  createTodoInputSchema,
  todoRecordSchema,
  updateTodoInputSchema,
  type CreateTodoInput,
  type TodoRecord,
  type UpdateTodoInput,
} from "./todos";

export const todoTableSpecInput = {
  name: "todos",
  mode: "readwrite",
  primaryKey: {
    columns: ["id"],
  },
  shape: {
    tableName: "todos",
    shapeKey: "todos",
  },
  routes: {
    basePath: "/api/todos",
    allowBatch: false,
  },
  clientProjection: {
    syncedTable: "todos",
    overlayTable: "todo_overlay",
    journalTable: "todo_mutations",
    readModel: "todo_read_model",
  },
} satisfies TableSpecInput;

export const todoTableSpec = {
  ...todoTableSpecInput,
  schemas: {
    createSchema: createTodoInputSchema,
    updateSchema: updateTodoInputSchema,
    recordSchema: todoRecordSchema,
  },
  adapters: {
    toEntityKey: (record) => ({
      id: String(record.id),
    }),
  },
} satisfies TableSpec<CreateTodoInput, UpdateTodoInput, TodoRecord>;
