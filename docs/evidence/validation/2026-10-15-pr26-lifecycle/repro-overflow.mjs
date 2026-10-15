const deadline = Date.now() + 30 * 24 * 60 * 60 * 1000;
const started = Date.now();
let fired = false;
const timer = setTimeout(() => { fired = true; process.stdout.write(JSON.stringify({ fired, elapsedMs: Date.now() - started, requestedMs: deadline - started }) + "\n"); }, Math.max(0, deadline - Date.now()));
timer.unref();
setTimeout(() => { if (!fired) process.stdout.write(JSON.stringify({ fired, elapsedMs: Date.now() - started, requestedMs: deadline - started }) + "\n"); }, 25);
