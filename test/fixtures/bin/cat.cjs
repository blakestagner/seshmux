// Cross-platform stand-in for `/bin/cat` in PTY tests: echo stdin back on
// stdout and stay alive until killed. Windows has no /bin/cat, and node-pty
// throws synchronously ("File not found") on a missing spawn target — inside
// daemon/holder.js that throw kills the detached holder before it binds its
// socket, so tests saw no echo, no exit, just a timeout.
//
// STAY ALIVE UNTIL KILLED is load-bearing, not incidental. Every caller models a
// live interactive agent session and ends it with an explicit kill; none expects
// this to exit on its own. Relying on the piped stdin to hold the event loop open
// made that a coin flip: stdin is the ONLY ref'd handle, so any EOF/close on the
// pty's input side ends stdin -> drains the loop -> exits -> the daemon broadcasts
// 'exit' -> the hub broadcasts 'idle'. On the node-20 Windows CI runner that
// surfaced as events-hub's timeout-path test getting {status:'idle'} where it
// required {status:'timeout'}: nothing "went idle" (no heuristic can — SILENCE_MS
// is 20s and the window is ~1s), the PTY had simply died. Suspected ConPTY conin
// EOF; unproven, as node 22 + node 24 don't reproduce it.
//
// So hold the loop open explicitly and don't let stdin EOF end the process. The
// ref'd interval is what keeps us alive; it costs one wakeup/sec and dies with the
// process on kill. posix runs this same fixture (helpers/platform.ts catPty()) —
// real `cat` would exit on EOF, but this fixture never claimed to be `cat`, and no
// test asks it to exit by itself. Exit-code coverage uses nodeScriptPty() instead.
process.stdin.pipe(process.stdout);
process.stdin.on('end', () => {}); // EOF must not be fatal — see above
process.stdin.on('error', () => {}); // a closed conin must not crash the echo
setInterval(() => {}, 1000); // ref'd on purpose: the keep-alive
