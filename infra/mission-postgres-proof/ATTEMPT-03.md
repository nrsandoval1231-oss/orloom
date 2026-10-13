# Controller repeat helper attempt — precondition comparison

- Candidate/bundle: source manifest `c418a11e1e616eda7d1005c45a317082013d2c9923883f9dd58ed92bf414b287`, bundle manifest `5840ff1f91c4c4c9b2757a24e2956ffb9fadc693662d59e6b86a8ad0ffb6de97`.
- Result: controller's first helper invocation exited 1 before any DB reset or test. A line-only trap identified the safe precondition mismatch: Docker emits empty `HostConfig.PortBindings` as `{}`, while the helper expected `null`.
- Repair: compare the exact expected empty object `{}` for both containers. `--check-only` then passed every precondition, including source and bundle manifest hashes. The controller's subsequent independent reset-and-rerun exited 0 and all proof checks passed.
- No environment values, credentials, command trace, or driver errors were printed in diagnosis.
