#!/usr/bin/env python3
"""Owner-run, local-only setup of the Orloom Infisical machine secret file."""
from __future__ import annotations

import getpass
import os
import secrets
import stat
import sys
from pathlib import Path

DESTINATION = Path("/etc/orloom/infisical-client-secret")


def _write_secret(secret: str, destination: Path, *, require_root: bool = True) -> None:
    if require_root and os.geteuid() != 0:
        raise RuntimeError("must run as root")
    if not secret or "\0" in secret or "\n" in secret or "\r" in secret:
        raise ValueError("invalid secret input")
    encoded = secret.encode("utf-8")
    if len(encoded) > 8192:
        raise ValueError("secret input exceeds the 8192-byte limit")

    parent = destination.parent
    parent_info = parent.lstat()
    if (not stat.S_ISDIR(parent_info.st_mode) or (require_root and parent_info.st_uid != 0)
            or (require_root and stat.S_IMODE(parent_info.st_mode) != 0o700)):
        raise RuntimeError("secret directory must be an existing root-owned mode-0700 directory")
    if destination.name in ("", ".", ".."):
        raise RuntimeError("invalid destination")
    try:
        destination.lstat()
    except FileNotFoundError:
        pass
    else:
        raise FileExistsError("destination already exists; refusing overwrite")

    directory_fd = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    temporary_name = f".{destination.name}.{secrets.token_hex(16)}.tmp"
    temporary_fd = -1
    try:
        # Recheck through the open directory descriptor to close the check/use race.
        try:
            os.stat(destination.name, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError("destination already exists; refusing overwrite")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        temporary_fd = os.open(temporary_name, flags, 0o600, dir_fd=directory_fd)
        payload = bytearray(encoded)
        try:
            view = memoryview(payload)
            while view:
                written = os.write(temporary_fd, view)
                if written <= 0:
                    raise OSError("secret file write made no progress")
                view = view[written:]
            os.fsync(temporary_fd)
            os.fchmod(temporary_fd, 0o600)
        finally:
            payload[:] = b"\0" * len(payload)
        os.close(temporary_fd)
        temporary_fd = -1
        # link is atomic and fails if any destination (including a symlink) exists.
        os.link(temporary_name, destination.name, src_dir_fd=directory_fd,
                dst_dir_fd=directory_fd, follow_symlinks=False)
        os.fsync(directory_fd)
    finally:
        if temporary_fd >= 0:
            os.close(temporary_fd)
        try:
            os.unlink(temporary_name, dir_fd=directory_fd)
        except FileNotFoundError:
            pass
        os.close(directory_fd)


def main() -> int:
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        print("A real interactive SSH terminal is required.", file=sys.stderr)
        return 2
    secret: str | None = None
    try:
        secret = getpass.getpass("Paste the Infisical client secret (input is hidden): ")
        _write_secret(secret, DESTINATION)
        print("Client secret saved with owner-only permissions.")
        return 0
    except Exception:
        print("Secret setup failed; no secret was printed. Check the destination and permissions.", file=sys.stderr)
        return 1
    finally:
        # Best effort only; Python strings cannot be reliably zeroized.
        secret = None


if __name__ == "__main__":
    raise SystemExit(main())
