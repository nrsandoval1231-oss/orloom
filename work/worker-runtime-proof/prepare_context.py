#!/usr/bin/env python3
"""Create the two-file sandbox build context only after frozen candidate hashes are supplied."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys

BASE = "node:24-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd"
HEX = set("0123456789abcdef")


def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def checked_hash(value: str, label: str) -> str:
    value = value.lower()
    if len(value) != 64 or any(char not in HEX for char in value):
        raise SystemExit(f"{label} must be a lowercase SHA-256 hex digest")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--context", required=True, type=Path)
    parser.add_argument("--source-manifest-sha256", required=True)
    parser.add_argument("--dockerfile-sha256", required=True)
    parser.add_argument("--sandbox-source-sha256", required=True)
    parser.add_argument("--compiled-entry-sha256", required=True)
    args = parser.parse_args()

    repo = args.repo_root.resolve(strict=True)
    ctx = args.context.absolute()
    expected_ctx = Path(__file__).resolve().parent / "candidate-context"
    if os.path.normcase(str(ctx)) != os.path.normcase(str(expected_ctx)):
        raise SystemExit("context must be the dedicated worker-runtime-proof/candidate-context directory")
    if ctx.is_symlink():
        raise SystemExit("candidate context may not be a symlink")
    # The caller provides a separate short-lived directory; ensure no unrelated content is overwritten.
    if ctx.exists() and any(ctx.iterdir()):
        raise SystemExit("context directory already contains files")
    metadata_path = ctx.parent / "candidate-context-proof.json"
    if metadata_path.exists() or metadata_path.is_symlink():
        raise SystemExit("refusing to overwrite existing candidate context identity file")
    if not ctx.exists():
        ctx.mkdir(parents=True, mode=0o700)
    for label, value in (("source manifest", args.source_manifest_sha256),
                         ("Dockerfile", args.dockerfile_sha256),
                         ("sandbox source", args.sandbox_source_sha256),
                         ("compiled entry", args.compiled_entry_sha256)):
        checked_hash(value, label)

    def source_file(relative: str) -> Path:
        candidate = repo
        for part in Path(relative).parts:
            candidate = candidate / part
            try:
                mode = candidate.lstat().st_mode
            except FileNotFoundError:
                raise SystemExit(f"required file missing: {relative}")
            if stat.S_ISLNK(mode):
                raise SystemExit(f"symlink in allowlisted source path: {relative}")
        if not stat.S_ISREG(candidate.lstat().st_mode):
            raise SystemExit(f"allowlisted source is not a regular file: {relative}")
        return candidate

    dockerfile = source_file("apps/worker/Dockerfile.sandbox")
    sandbox_source = source_file("apps/worker/src/sandbox-entry.ts")
    compiled = source_file("dist/apps/worker/src/sandbox-entry.js")
    actual = {"dockerfile": sha(dockerfile), "sandboxSource": sha(sandbox_source), "compiledEntry": sha(compiled)}
    expected = {"dockerfile": args.dockerfile_sha256.lower(), "sandboxSource": args.sandbox_source_sha256.lower(), "compiledEntry": args.compiled_entry_sha256.lower()}
    if actual != expected:
        raise SystemExit("frozen-file hash mismatch; refusing to stage build context")

    shutil.copyfile(dockerfile, ctx / "Dockerfile.sandbox")
    target = ctx / "dist/apps/worker/src/sandbox-entry.js"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(compiled, target)
    metadata = {
        "sourceManifestSha256": args.source_manifest_sha256.lower(),
        "files": actual,
        "nodeBase": BASE,
        "platform": "linux/amd64",
        "contextFiles": ["Dockerfile.sandbox", "dist/apps/worker/src/sandbox-entry.js"]
    }
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metadata, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
