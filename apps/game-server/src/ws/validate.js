import { z } from 'zod';

export const TableJoinSchema = z.object({
  tableId: z.string().min(1).max(64),
});

export const TableLeaveSchema = z.object({
  tableId: z.string().min(1).max(64),
});

export const TableSitSchema = z.object({
  tableId: z.string().min(1).max(64),
  seat: z.number().int().min(0).max(9),
  buyIn: z.number().int().positive().max(1000000),
});

export const TableReadySchema = z.object({
  tableId: z.string().min(1).max(64),
  ready: z.boolean(),
});

/**
 * @template T
 * @param {import('zod').ZodSchema<T>} schema
 * @param {unknown} data
 * @returns {{ ok: true, data: T } | { ok: false, code: string, message: string }}
 */
export function parseOrError(schema, data) {
  const r = schema.safeParse(data);
  if (r.success) return { ok: true, data: r.data };
  const first = r.error.issues[0];
  return {
    ok: false,
    code: 'INVALID_PAYLOAD',
    message: `${first.path.join('.')}: ${first.message}`,
  };
}