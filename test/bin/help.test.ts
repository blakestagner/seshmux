import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const bin = fileURLToPath(new URL('../../bin/seshmux.js', import.meta.url));

// The help path lives inside main(), so exercise it through the real CLI. It must
// print usage, exit 0, and NEVER start a server / touch the daemon (a hang here
// would mean it fell through to the server flow).
function run(args: string[]) {
  return execFileP(process.execPath, [bin, ...args], { timeout: 10_000 });
}

describe('seshmux --help', () => {
  it('prints usage with the commands and every flag, and exits 0', async () => {
    for (const flag of ['--help', '-h', 'help']) {
      const { stdout } = await run([flag]);
      expect(stdout).toMatch(/Usage:/);
      // commands
      expect(stdout).toMatch(/seshmux update/);
      expect(stdout).toMatch(/seshmux version/);
      // every user-facing flag
      for (const opt of ['--port', '--host', '--no-open', '--restart-daemon', '--version', '--help']) {
        expect(stdout).toContain(opt);
      }
      // internal-only command must NOT be advertised
      expect(stdout).not.toMatch(/mcp-bridge/);
    }
  });
});
