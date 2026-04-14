import { z } from "zod";

export const unixMicrosecondsSchema = z.string().regex(/^[0-9]+$/);
