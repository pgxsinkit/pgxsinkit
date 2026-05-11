import { z } from "zod";

import { unixMicrosecondsSchema } from "@pgxsinkit/contracts";

export const todoStatusSchema = z.enum(["todo", "in_progress", "done"]);
export const todoPrioritySchema = z.enum(["low", "medium", "high"]);

export const todoIdSchema = z.uuid();
const todoAuthorIdSchema = z.uuid();

const todoFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(4000).nullable().optional(),
    authorId: todoAuthorIdSchema,
    status: todoStatusSchema,
    priority: todoPrioritySchema,
  })
  .strict();

const createTodoFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(4000).nullable().optional(),
    authorId: todoAuthorIdSchema,
    status: todoStatusSchema.default("todo"),
    priority: todoPrioritySchema.default("medium"),
  })
  .strict();

export const createTodoInputSchema = createTodoFieldsSchema.extend({
  id: todoIdSchema,
});

export const updateTodoInputSchema = todoFieldsSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field must be provided");

export const todoRecordSchema = z.object({
  id: todoIdSchema,
  title: z.string().trim().min(1).max(120),
  description: z.string().nullable(),
  authorId: todoAuthorIdSchema,
  ownerId: z.uuid().nullable().optional(),
  modifiedBy: z.uuid().nullable().optional(),
  status: todoStatusSchema,
  priority: todoPrioritySchema,
  createdAtUs: unixMicrosecondsSchema,
  updatedAtUs: unixMicrosecondsSchema,
});

export const todoListSchema = z.array(todoRecordSchema);

export type CreateTodoInput = z.infer<typeof createTodoInputSchema>;
export type UpdateTodoInput = z.infer<typeof updateTodoInputSchema>;
export type TodoRecord = z.infer<typeof todoRecordSchema>;
