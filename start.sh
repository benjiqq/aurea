#!/usr/bin/env bash
set -eo pipefail
cd -- "$(dirname -- "$0")"

reset=false
standalone=false
for option in "$@"; do
  case "$option" in
    --reset) reset=true ;;
    --standalone) standalone=true ;;
    *)
      printf 'Usage: %s [--standalone] [--reset]\n' "$0" >&2
      exit 2
      ;;
  esac
done

if "$standalone"; then
  databases=(data/aurea.sqlite3)
  ports=(8080)
  peers=("")
else
  databases=(data/aurea-a.sqlite3 data/aurea-b.sqlite3)
  ports=(8081 8082)
  peers=(http://127.0.0.1:8082 http://127.0.0.1:8081)
fi

if "$reset"; then
  if ! command -v lsof >/dev/null; then
    printf 'Install lsof before resetting a ledger so open databases can be detected.\n' >&2
    exit 1
  fi
  for database in "${databases[@]}"; do
    if [[ -e "$database" ]] && lsof -t -- "$database" >/dev/null 2>&1; then
      printf 'Stop the node using %s before resetting it.\n' "$database" >&2
      exit 1
    fi
  done
  for port in "${ports[@]}"; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
      printf 'Free port %s before resetting the ledger.\n' "$port" >&2
      exit 1
    fi
  done
fi

npm run build

if "$reset"; then
  mkdir -p data/.aurea-reset
  archive=$(mktemp -d data/.aurea-reset/ledger-XXXXXXXX)
  for database in "${databases[@]}"; do
    for file in "$database" "$database-journal" "$database-wal" "$database-shm"; do
      if [[ -e "$file" ]]; then
        mv -- "$file" "$archive/"
      fi
    done
  done
  printf 'Archived previous ledger files in %s\n' "$archive"
fi

mkdir -p data
mkdir -p -m 700 secrets

pids=()
stop_nodes() {
  for pid in "${pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in "${pids[@]}"; do
    wait "$pid" || true
  done
}
trap stop_nodes EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for index in "${!databases[@]}"; do
  database=${databases[index]}
  # Keep this key path stable across ledger resets.
  AUREA_DB="$database" AUREA_NODE_KEY="secrets/${database##*/}.node-key.pem" \
    PORT="${ports[index]}" AUREA_PEERS="${peers[index]}" node src/server.js &
  pids+=("$!")
done

while true; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      exit
    fi
  done
  sleep 1
done
