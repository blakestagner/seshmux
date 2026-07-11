// GET /api/env -> environment detection (agent CLIs + tmux/rg + store presence) plus the
// agent-bridge MCP registration status. bridgeStatus() only READS the agents' config files
// (never writes — registration is the explicit POST /api/bridge/register button).

import type { FastifyInstance } from 'fastify';
import { detectEnv } from '../lib/detect';
import { bridgeStatus as realBridgeStatus } from '../lib/bridge/registry';
import { getProviders } from '../lib/providers/types';

export interface EnvRouteDeps {
  bridgeStatus?: () => Promise<{ claude: boolean; codex: boolean }>;
}

// Command previews for the New-session modal (hard rule 3 — the UI must not know argv or
// binary names). Built from the SAME provider.commands used to actually spawn, so a preview
// can never drift from what will really run. cwd is irrelevant to the string shown, so a
// placeholder is fine — commands.fresh/continue/plan don't interpolate it into the printed form.
function commandPreview(commands: {
  fresh(cwd: string): string[];
  continue(cwd: string): string[];
  plan?(cwd: string): string[];
}): { fresh: string; continue: string; plan?: string; hasPlan: boolean } {
  return {
    fresh: commands.fresh('').join(' '),
    continue: commands.continue('').join(' '),
    ...(commands.plan ? { plan: commands.plan('').join(' ') } : {}),
    hasPlan: !!commands.plan,
  };
}

export default async function envRoutes(f: FastifyInstance, deps: EnvRouteDeps = {}) {
  const bridgeStatus = deps.bridgeStatus ?? (() => realBridgeStatus());

  f.get('/api/env', async () => {
    const [env, bridge, providers] = await Promise.all([
      detectEnv(),
      bridgeStatus().catch(() => ({ claude: false, codex: false })),
      getProviders(),
    ]);
    const commands: Record<string, ReturnType<typeof commandPreview>> = {};
    // Task 5 Step 1b: teammateMode gate for the Teams entry points — only
    // providers that implement TeamSupport report it (claude only today).
    const teams: Record<string, { teammateMode: string | null }> = {};
    for (const p of providers) {
      commands[p.id] = commandPreview(p.commands);
      // JSON drops `undefined` keys on serialize — use null so the client
      // always sees the field present (absent vs. present-but-unset matter
      // for the teamsAllowed() gate's "no opinion" case).
      if (p.teams) teams[p.id] = { teammateMode: (await p.teams.teammateMode().catch(() => undefined)) ?? null };
    }
    return {
      ...env,
      bridge: {
        claude: { registered: bridge.claude },
        codex: { registered: bridge.codex },
      },
      commands,
      teams,
    };
  });
}
