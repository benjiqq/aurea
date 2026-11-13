#!/usr/bin/env bash
set -e
cd -- "$(dirname -- "$0")"

usage() {
  printf 'Usage: %s [--standalone | --all]\n' "$0" >&2
  exit 2
}

if (( $# > 1 )); then usage; fi
case "${1-}" in
  "") ports=(8081 8082); databases=(data/aurea-a.sqlite3 data/aurea-b.sqlite3) ;;
  --standalone) ports=(8080); databases=(data/aurea.sqlite3) ;;
  --all) ports=(8080 8081 8082); databases=(data/aurea.sqlite3 data/aurea-a.sqlite3 data/aurea-b.sqlite3) ;;
  *) usage ;;
esac

if ! command -v lsof >/dev/null; then
  printf 'Install lsof to identify the running Aurea nodes.\n' >&2
  exit 1
fi

pids=()
for index in "${!ports[@]}"; do
  port=${ports[index]}
  database=${databases[index]}
  if ! pid=$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN); then
    continue
  fi
  if [[ ! "$pid" =~ ^[0-9]+$ ]] ||
     [[ "$(lsof -a -p "$pid" -t -- "$PWD/$database" 2>/dev/null)" != "$pid" ]]; then
    printf 'Port %s is in use by a process other than the Aurea node for %s.\n' "$port" "$database" >&2
    exit 1
  fi
  pids+=("$pid")
done

if (( ${#pids[@]} == 0 )); then
  printf 'No matching Aurea nodes are running.\n'
  exit 0
fi

for pid in "${pids[@]}"; do
  if ! kill -TERM "$pid" 2>/dev/null && kill -0 "$pid" 2>/dev/null; then
    printf 'Could not signal Aurea process %s.\n' "$pid" >&2
    exit 1
  fi
done

for (( attempt = 0; attempt < 50; attempt++ )); do
  running=false
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then running=true; fi
  done
  if ! "$running"; then
    printf 'Aurea nodes stopped.\n'
    exit 0
  fi
  sleep 0.2
done

printf 'Timed out waiting for Aurea nodes to stop.\n' >&2
exit 1
