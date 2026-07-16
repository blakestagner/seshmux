// Standalone MCP bridge entry. esbuild bundles this to
// .next/standalone/seshmux-mcp-bridge.js, which bin/seshmux.js runs for the
// `seshmux mcp-bridge` subcommand in prod. Speaks stdio — no web server.
import { startMcpBridge } from '../server/lib/bridge/mcp';

startMcpBridge().catch((err) => {
  console.error('[seshmux] mcp-bridge failed to start:', err);
  process.exit(1);
});
