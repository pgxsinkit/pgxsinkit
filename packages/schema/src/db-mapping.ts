import { createAuthorInputSchema, updateAuthorInputSchema } from "./authors";
import { type NewAuthorRow, type NewTodoRow } from "./schema";
import { createTodoInputSchema, updateTodoInputSchema } from "./todos";

export function mapCreateAuthorToInsert(input: unknown): NewAuthorRow {
  const parsed = createAuthorInputSchema.parse(input);
  return {
    id: parsed.id,
    name: parsed.name,
  };
}

export function mapCreateTodoToInsert(input: unknown): NewTodoRow {
  const parsed = createTodoInputSchema.parse(input);
  return {
    id: parsed.id,
    title: parsed.title,
    description: parsed.description ?? null,
    authorId: parsed.authorId,
    status: parsed.status,
    priority: parsed.priority,
  };
}

export function mapUpdateAuthorToValues(input: unknown) {
  const parsed = updateAuthorInputSchema.parse(input);
  return {
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
  };
}

export function mapUpdateTodoToValues(input: unknown) {
  const parsed = updateTodoInputSchema.parse(input);
  return {
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
    ...(parsed.description !== undefined ? { description: parsed.description ?? null } : {}),
    ...(parsed.authorId !== undefined ? { authorId: parsed.authorId } : {}),
    ...(parsed.status !== undefined ? { status: parsed.status } : {}),
    ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
  };
}
