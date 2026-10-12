import { z } from 'zod';

export const TableJoinSchema = z.object({
  tableId: z.string().min(1).max(64),
});

export const TableLeaveSchema = z.object({
  tableId: z.string().min(1).max(64),
});

export const TableSitSchema = z.object({
  tableId: z.string().min(1).max(64),
  seat: z.number().int().min(-1).max(9),
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
export const GameActionSchema = z.object({
  tableId: z.string().min(1).max(64),
  handId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('fold') }),
    z.object({ type: z.literal('check') }),
    z.object({ type: z.literal('call') }),
    z.object({ type: z.literal('bet'), amount: z.number().int().positive() }),
    z.object({ type: z.literal('raise'), amount: z.number().int().positive() }),
    z.object({ type: z.literal('all_in') }),
  ]),
});