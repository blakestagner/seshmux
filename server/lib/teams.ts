// Team templates: user-defined reusable team shapes over <configDir>/teams.json.
// SEPARATE from Claude Code's ~/.claude/teams/ runtime dir (we only READ that, in
// the claude provider). composeTeamPrompt turns a template + task into the prose
// firstPrompt the lead session receives — data → text, unit-testable, no I/O.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { configDir } from '../daemon-client';

export interface TeamMemberTemplate { name: string; role: string; model?: 'opus' | 'sonnet' | 'haiku'; }
export interface TeamTemplate { name: string; members: TeamMemberTemplate[]; createdAt: number; }

const file = () => path.join(configDir(), 'teams.json');

// Collapse untrusted user text to a single line: member names/roles and the task
// are DATA. A bare newline in them must not be able to forge a new instruction
// line in the composed prompt (prompt-injection posture, spec §Testing).
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

export function composeTeamPrompt(
  t: { name: string; members: TeamMemberTemplate[] },
  task: string,
): string {
  const roster = t.members
    .map((m) => `  - ${oneLine(m.name)} — ${oneLine(m.role)}${m.model ? ` (${m.model})` : ''}`)
    .join('\n');
  return [
    `Create an agent team named ${oneLine(t.name)}. Teammates:`,
    roster,
    ``,
    `Once the team is assembled, begin this task:`,
    oneLine(task),
  ].join('\n');
}

async function readAll(): Promise<TeamTemplate[]> {
  try { return JSON.parse(await readFile(file(), 'utf8')) as TeamTemplate[]; }
  catch { return []; }
}
async function writeAll(list: TeamTemplate[]): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  // Unique tmp name: a static `teams.json.tmp` is shared by every concurrent writer, so the
  // first rename() moves it away and the second fails ENOENT. Same pattern as
  // bridge/registry.ts and routes/scratchpad.ts (D5-2, sibling of workspaces.ts).
  const tmp = path.join(configDir(), `.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
  await rename(tmp, file());
}

// Serialized read-modify-write — same reason as workspaces.ts: two templates saved at once
// each read the same snapshot and the last write dropped the other. In-process chain; the
// server is the only writer of teams.json.
let writeChain: Promise<unknown> = Promise.resolve();
function update(mutate: (list: TeamTemplate[]) => TeamTemplate[]): Promise<void> {
  const run = writeChain.then(async () => {
    await writeAll(mutate(await readAll()));
  });
  writeChain = run.catch(() => {}); // a failed mutation must not poison the chain
  return run;
}

export const listTemplates = readAll;
export async function saveTemplate(t: Omit<TeamTemplate, 'createdAt'>): Promise<TeamTemplate> {
  const rec: TeamTemplate = { ...t, createdAt: Date.now() };
  await update((list) => [...list.filter((x) => x.name !== rec.name), rec]);
  return rec;
}
export async function deleteTemplate(name: string): Promise<void> {
  await update((list) => list.filter((x) => x.name !== name));
}
