import { z } from 'zod';
import { isAbsolute } from 'node:path';

const schema = z.object({
  GMAIL_ADDRESS: z.email().regex(/^[^\s<>@]+@gmail\.com$/i),
  GMAIL_APP_PASSWORD: z.string().transform(v => v.replace(/ /g, '')).pipe(z.string().regex(/^[a-zA-Z]{16}$/)),
  GEMINI_API_KEY: z.string().min(20),
  GEMINI_MODEL: z.string().regex(/^gemini-[a-z0-9.-]+$/),
  MAIL_START_AT: z.iso.datetime({ offset: true }),
  DATA_DIR: z.string().refine(isAbsolute),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Node 24 is required');
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`Invalid configuration: ${[...new Set(result.error.issues.map(i => i.path[0]))].join(', ')}`);
  if (Date.parse(result.data.MAIL_START_AT) > Date.now()) throw new Error('MAIL_START_AT is in the future');
  return result.data;
}
