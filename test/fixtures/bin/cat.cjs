// Cross-platform stand-in for `/bin/cat` in PTY tests: echo stdin back on
// stdout and stay alive until killed. Windows has no /bin/cat, and node-pty
// throws synchronously ("File not found") on a missing spawn target — inside
// daemon/holder.js that throw kills the detached holder before it binds its
// socket, so tests saw no echo, no exit, just a timeout.
process.stdin.pipe(process.stdout);
