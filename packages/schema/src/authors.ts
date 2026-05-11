import { z } from "zod";

import { unixMicrosecondsSchema } from "@pgxsinkit/contracts";

export const authorIdSchema = z.uuid();

const authorFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
  })
  .strict();

export const createAuthorInputSchema = authorFieldsSchema.extend({
  id: authorIdSchema,
});

export const updateAuthorInputSchema = authorFieldsSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field must be provided");

export const authorRecordSchema = z.object({
  id: authorIdSchema,
  name: z.string().trim().min(1).max(120),
  ownerId: z.uuid().nullable().optional(),
  modifiedBy: z.uuid().nullable().optional(),
  createdAtUs: unixMicrosecondsSchema,
  updatedAtUs: unixMicrosecondsSchema,
});

export const authorListSchema = z.array(authorRecordSchema);

export type CreateAuthorInput = z.infer<typeof createAuthorInputSchema>;
export type UpdateAuthorInput = z.infer<typeof updateAuthorInputSchema>;
export type AuthorRecord = z.infer<typeof authorRecordSchema>;
