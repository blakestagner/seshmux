// Standalone production server entry. esbuild bundles this to
// .next/standalone/seshmux-server.js. The renamed bundle won't match
// server/index.ts's isMain guard, so we call startServer() explicitly.
import { startServer } from '../server/index';

const port = Number(process.env.PORT) || 4700;
startServer({ port, dev: false }).then(
  () => {
    console.log(`[seshmux] production server on http://127.0.0.1:${port}`);
  },
  (err) => {
    console.error('[seshmux] server failed to start:', err);
    process.exit(1);
  },
);
