#!/bin/sh
case "${1-}" in
  "Username for 'https://github.com': ") printf '%s\n' 'x-access-token' ;;
  "Password for 'https://github.com': "|"Password for 'https://x-access-token@github.com': ")
    [ -n "${ORLOOM_GIT_UPLOAD_TOKEN-}" ] || exit 1
    printf '%s\n' "$ORLOOM_GIT_UPLOAD_TOKEN"
    ;;
  *) exit 1 ;;
esac
