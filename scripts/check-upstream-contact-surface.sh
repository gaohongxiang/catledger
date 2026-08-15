#!/usr/bin/env sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
WHITELIST=${WHITELIST:-"$SCRIPT_DIR/upstream-contact-surface.whitelist"}
UPSTREAM_REF=${UPSTREAM_REF:-upstream/main}
HEAD_REF=${HEAD_REF:-HEAD}

show_help() {
    cat <<'EOF'
比较 upstream/main...HEAD 中实际改动的上游核心文件与仓库白名单是否一致。

用法：
    scripts/check-upstream-contact-surface.sh

环境变量：
    UPSTREAM_REF  上游引用，默认 upstream/main
    HEAD_REF      产品引用，默认 HEAD
    WHITELIST     白名单文件，默认 scripts/upstream-contact-surface.whitelist

未登记的新接触文件、或白名单中已不存在于当前 diff 的路径，都会失败。
EOF
}

fail() {
    printf '错误：%s\n' "$1" >&2
    exit 1
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    show_help
    exit 0
fi

command -v git >/dev/null 2>&1 || fail "未找到 git"
command -v comm >/dev/null 2>&1 || fail "未找到 comm"
command -v sort >/dev/null 2>&1 || fail "未找到 sort"
command -v awk >/dev/null 2>&1 || fail "未找到 awk"

cd "$REPOSITORY_ROOT"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "当前目录不是 git 仓库"

if ! git rev-parse --verify "$UPSTREAM_REF" >/dev/null 2>&1; then
    fail "找不到上游引用 $UPSTREAM_REF，请先 git fetch upstream"
fi

if ! git rev-parse --verify "$HEAD_REF" >/dev/null 2>&1; then
    fail "找不到产品引用 $HEAD_REF"
fi

if [ ! -f "$WHITELIST" ]; then
    fail "找不到白名单文件 $WHITELIST"
fi

MERGE_BASE=$(git merge-base "$UPSTREAM_REF" "$HEAD_REF") || fail "无法计算 $UPSTREAM_REF 与 $HEAD_REF 的 merge-base"

TMPDIR_PATH=$(mktemp -d "${TMPDIR:-/tmp}/ezbk-contact-surface.XXXXXX")
cleanup() {
    rm -rf "$TMPDIR_PATH"
}
trap cleanup EXIT INT HUP TERM

TOUCHED="$TMPDIR_PATH/touched"
CHANGED="$TMPDIR_PATH/changed"
UPSTREAM_FILES="$TMPDIR_PATH/upstream-files"
EXPECTED="$TMPDIR_PATH/expected"
UNREGISTERED="$TMPDIR_PATH/unregistered"
STALE="$TMPDIR_PATH/stale"

git diff --name-only --diff-filter=ACDMRTUXB "${MERGE_BASE}...${HEAD_REF}" | sort -u > "$CHANGED"
{
    git ls-tree -r --name-only "$UPSTREAM_REF"
    git ls-tree -r --name-only "$MERGE_BASE"
} | sort -u > "$UPSTREAM_FILES"
comm -12 "$CHANGED" "$UPSTREAM_FILES" > "$TOUCHED"

awk '
    /^[[:space:]]*$/ { next }
    /^[[:space:]]*#/ { next }
    { print }
' "$WHITELIST" | sort -u > "$EXPECTED"

if [ ! -s "$EXPECTED" ]; then
    fail "白名单 $WHITELIST 没有有效路径"
fi

comm -23 "$TOUCHED" "$EXPECTED" > "$UNREGISTERED"
comm -13 "$TOUCHED" "$EXPECTED" > "$STALE"

status=0

if [ -s "$UNREGISTERED" ]; then
    status=1
    printf '错误：发现未登记的上游接触文件。新增前必须更新白名单并回答 15.4 四问：\n' >&2
    sed 's/^/  /' "$UNREGISTERED" >&2
fi

if [ -s "$STALE" ]; then
    status=1
    printf '错误：白名单含有当前 %s...%s 未触及的路径，请同步更新白名单：\n' "$UPSTREAM_REF" "$HEAD_REF" >&2
    sed 's/^/  /' "$STALE" >&2
fi

if [ "$status" -ne 0 ]; then
    printf '接触面白名单比对失败。touched=%s whitelist=%s merge-base=%s\n' \
        "$(wc -l < "$TOUCHED" | tr -d '[:space:]')" \
        "$(wc -l < "$EXPECTED" | tr -d '[:space:]')" \
        "$MERGE_BASE" >&2
    exit 1
fi

printf '接触面白名单比对通过：%s 个上游核心文件与白名单一致（%s...%s，merge-base %s）。\n' \
    "$(wc -l < "$TOUCHED" | tr -d '[:space:]')" \
    "$UPSTREAM_REF" \
    "$HEAD_REF" \
    "$MERGE_BASE"
