#!/usr/bin/env bash
# 备份 store.db（SQLite 在线备份，不需要停容器），并按份数轮转。
#
#   make backup
#   BACKUP_KEEP=30 make backup
#
# 用 sqlite3 的 .backup 而不是 cp：容器在写库时直接拷文件可能拿到半页数据。
set -euo pipefail

DATA="${DATA:-.data}"
DIR="${BACKUP_DIR:-$DATA/backups}"
KEEP="${BACKUP_KEEP:-14}"

if [ ! -f "$DATA/store.db" ]; then
  echo "backup: $DATA/store.db 不存在" >&2
  exit 1
fi
mkdir -p "$DIR"
chmod 700 "$DIR"

TS="$(date +%Y%m%d-%H%M%S)"
OUT="$DIR/store-$TS.db"
sqlite3 "$DATA/store.db" ".backup '$OUT'"
chmod 600 "$OUT"
echo "backup: $OUT ($(du -h "$OUT" | cut -f1))"

# 只保留最近 KEEP 份；BSD/GNU 的 ls -t 都能用。
COUNT="$(find "$DIR" -maxdepth 1 -name 'store-*.db' | wc -l | tr -d ' ')"
if [ "$COUNT" -gt "$KEEP" ]; then
  find "$DIR" -maxdepth 1 -name 'store-*.db' -print0 | xargs -0 ls -1t | tail -n +"$((KEEP + 1))" | while IFS= read -r f; do
    rm -f "$f"
    echo "backup: pruned $f"
  done
fi
