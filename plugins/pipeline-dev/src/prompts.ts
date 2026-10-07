import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = new URL('../prompts/', import.meta.url);

/** Fill {{name}} slots in a prompt file. Unknown slots become empty text. */
export function renderPrompt(name: string, vars: Record<string, string>): string {
  const raw = readFileSync(fileURLToPath(new URL(`${name}.md`, dir)), 'utf8');
  return raw.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '').replace(/\n{3,}/g, '\n\n').trim();
}
