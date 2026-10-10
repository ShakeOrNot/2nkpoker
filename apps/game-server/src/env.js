import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3001),
  JWT_SECRET: z.string().min(1),
  JWT_ISSUER: z.string().default('2nkpoker'),
  JWT_AUDIENCE: z.string().default('2nkpoker-web'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
});

export const env = schema.parse(process.env);