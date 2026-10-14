// Composition deliberately retains no environment-variable bypass. The preserved
// broker entrypoint is not an accepted executable until independent candidate
// admission and interrupted-worker reconciliation are implemented and reviewed.
process.stderr.write("Orloom worker composition is disabled: independent candidate admission and cancellation reconciliation are not configured.\n");
process.exitCode = 1;
