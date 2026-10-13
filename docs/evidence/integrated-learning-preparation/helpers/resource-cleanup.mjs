function bounded(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline`)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

// Always attempts both resources. A timed-out graceful server close is force-closed
// and observed once more; its timeout remains recorded even if force-close succeeds.
export async function closeResources(resources, milliseconds = 10_000) {
  const errors = [];
  const { server, jobs } = resources;
  if (server?.listening) {
    resources.serverClosePromise ??= new Promise((resolve, reject) => server.close(error => error ? reject(new Error('control server close failed')) : resolve()));
    const closing = resources.serverClosePromise;
    try { await bounded(closing, milliseconds, 'control server close'); }
    catch (error) {
      errors.push(error);
      try { server.closeAllConnections?.(); } catch (forceError) { errors.push(new Error('control server force-close failed')); }
      try { await bounded(closing, milliseconds, 'control server force-close'); } catch (forceWaitError) { errors.push(forceWaitError); }
    }
  }
  if (jobs) {
    resources.jobsClosePromise ??= Promise.resolve().then(() => jobs.close());
    try { await bounded(resources.jobsClosePromise, milliseconds, 'postgres pool close'); }
    catch (error) { errors.push(error); }
  }
  return errors;
}

export async function closeTrackedControls(controls, closeOne) {
  const errors = [];
  for (const control of [...controls]) {
    try { await closeOne(control); }
    catch (error) { errors.push(error); }
  }
  return errors;
}
