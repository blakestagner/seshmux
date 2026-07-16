import { describe, it, expect, afterEach } from 'vitest';
import { ipcPath as serverIpcPath } from '../../server/lib/ipc';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ipcPath: daemonIpcPath } = require('../../daemon/ipc');

// The two implementations are deliberate mirrors (daemon/ is standalone, the
// server never imports it). If they ever drift, processes stop agreeing on the
// win32 pipe name and the daemon becomes unreachable — so test them AGAINST
// each other, not just individually.

const realPlatform = process.platform;
function setPlatform(p: string) {
  Object.defineProperty(process, 'platform', { value: p });
}
afterEach(() => setPlatform(realPlatform));

const SAMPLES = [
  '/Users/x/.config/seshmux/seshmuxd.sock',
  '/Users/x/.config/seshmux/holders/pty-1.sock',
  'C:\\Users\\x\\.config\\seshmux\\approval.sock',
];

describe('ipcPath', () => {
  it('is the identity on posix', () => {
    setPlatform('darwin');
    for (const p of SAMPLES) {
      expect(serverIpcPath(p)).toBe(p);
      expect(daemonIpcPath(p)).toBe(p);
    }
  });

  it('maps to a named pipe on win32, deterministically, mirrors agreeing', () => {
    setPlatform('win32');
    for (const p of SAMPLES) {
      const pipe = serverIpcPath(p);
      expect(pipe).toMatch(/^\\\\\.\\pipe\\seshmux-[0-9a-f]{12}-[\w.-]+$/);
      expect(daemonIpcPath(p)).toBe(pipe); // the load-bearing assertion
      expect(serverIpcPath(p)).toBe(pipe); // deterministic
    }
  });

  it('distinct paths get distinct pipes (two config dirs never collide)', () => {
    setPlatform('win32');
    const a = serverIpcPath('/a/seshmuxd.sock');
    const b = serverIpcPath('/b/seshmuxd.sock');
    expect(a).not.toBe(b);
  });
});
