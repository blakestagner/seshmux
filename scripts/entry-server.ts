// Standalone production server entry. esbuild bundles this to
// .next/standalone/seshmux-server.js. The renamed bundle won't match
// server/index.ts's isMain guard, so we call startServer() explicitly.
import { startServer } from '../server/index';
import { displayHost } from '../bin/lib/host.js';

const port = Number(process.env.PORT) || 4700;
const host = process.env.SESHMUX_HOST || '127.0.0.1';
startServer({ port, host, dev: false }).then(
  () => {
    console.log(`[seshmux] production server on http://${displayHost(host)}:${port}`);
  },
  (err) => {
    console.error('[seshmux] server failed to start:', err);
    process.exit(1);
  },
);
