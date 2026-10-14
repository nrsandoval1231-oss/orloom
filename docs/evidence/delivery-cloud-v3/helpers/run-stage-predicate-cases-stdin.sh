#!/usr/bin/env bash
set -euo pipefail
umask 077
payload=$(cat)
[[ -n $payload ]] || { echo 'predicate cases must be supplied on stdin' >&2; exit 64; }
jq -e 'type=="object" and .format=="orloom-c3-delivery-cloud-stage-predicate-cases-v2" and (.cases|type=="array" and length>=30)' <<<"$payload" >/dev/null
passed=0
while IFS= read -r encoded; do
  item=$(printf '%s' "$encoded" | base64 -d)
  name=$(jq -r .name <<<"$item")
  filter=$(jq -r .filter <<<"$item")
  expected=$(jq -r .expected <<<"$item")
  document=$(jq -c .document <<<"$item")
  arg() { jq -r --arg key "$1" '.args[$key].value // ""' <<<"$item"; }
  argjson() { jq -r --arg key "$1" '.args[$key].value // 0' <<<"$item"; }
  if printf '%s' "$document" | jq -e \
    --arg base "$(arg base)" --arg candidate "$(arg candidate)" \
    --arg ref "$(arg ref)" --arg manifest "$(arg manifest)" \
    --arg payload "$(arg payload)" --arg bundle "$(arg bundle)" \
    --argjson source_count "$(argjson source_count)" --argjson count "$(argjson count)" \
    --argjson compiled_count "$(argjson compiled_count)" \
    --argjson migration_count "$(argjson migration_count)" \
    --argjson dependency_count "$(argjson dependency_count)" "$filter" >/dev/null 2>&1; then
    actual=true
  else
    actual=false
  fi
  [[ $actual == "$expected" ]] || { printf 'predicate case failed: %s\n' "$name" >&2; exit 65; }
  passed=$((passed + 1))
done < <(jq -r '.cases[] | @base64' <<<"$payload")
printf 'predicate_cases=PASS\ncount=%s\n' "$passed"
