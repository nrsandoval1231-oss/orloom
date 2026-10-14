# C3-LINUX-SYMLINK-01 — Unix fixture symlink cleanup

**Objective:** Fix cleanup in the local integration fixture after adversarial directory-symlink checks fail on Linux with `ENOTDIR` from `rmdir`.

**Identity and scope:** Repository `work/orloom-linux-fixture`, branch `fix/linux-symlink-fixture`, base `bdd8065d1e6911cffb8fc44ecbc5bff72a661ce1`. Allowed: `tests/local-integration.test.ts`, this packet, and `.agent/C3-LINUX-SYMLINK-01-COMPLETION.json`. No production changes, skips, dependency installs, shared `node_modules` changes, host/Docker runs, commits, pushes, or merges.

**Repair:** Keep both adversarial assertions (object-store and refs/heads symlinks rejected). Remove each fixture symlink using the platform-appropriate filesystem operation, restore its renamed original directory, and assert symlink targets/original directories remain intact.

**Acceptance:** Build, typecheck, and focused local integration test pass on Windows; `git diff --check` passes. No Linux runtime claim unless independently run locally. Root owns cloud proof and integration.
