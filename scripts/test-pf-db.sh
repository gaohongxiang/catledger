#!/usr/bin/env sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$REPOSITORY_ROOT/docker/compose.pf-test.yml"
TARGET=${1:-all}
PROJECT_RANDOM=$(LC_ALL=C od -An -N4 -tx1 /dev/urandom | tr -d '[:space:]')
PROJECT_NAME="ezbk-pfqa-$(date '+%Y%m%d%H%M%S')-$$-$PROJECT_RANDOM"
CLEANUP_DONE=0

show_help() {
    cat <<'EOF'
个人财务数据库基线验证

用法：
    scripts/test-pf-db.sh [sqlite|mysql|postgres|all]

每种数据库都在独立进程中执行迁移、导入持久层集成测试和两次 database update。
MySQL 和 PostgreSQL 只运行在随机命名的内部 Docker 网络与 tmpfs 中，
不发布宿主端口，也不挂载仓库的 data、log 或 storage 目录。
EOF
}

fail() {
    printf '错误：%s\n' "$1" >&2
    exit 1
}

compose() {
    docker compose --project-name "$PROJECT_NAME" --file "$COMPOSE_FILE" "$@"
}

validate_project_name() {
    case "$PROJECT_NAME" in
        ezbk-pfqa-*)
            ;;
        *)
            fail "拒绝清理未识别的 Compose 项目 $PROJECT_NAME"
            ;;
    esac
}

cleanup_best_effort() {
    if [ "$CLEANUP_DONE" -eq 1 ]; then
        return
    fi

    case "$PROJECT_NAME" in
        ezbk-pfqa-*)
            if ! compose down --volumes --remove-orphans --rmi local >/dev/null 2>&1; then
                printf '警告：隔离测试资源自动清理失败，请检查 Compose 项目 %s\n' "$PROJECT_NAME" >&2
            fi
            ;;
        *)
            printf '拒绝清理未识别的 Compose 项目：%s\n' "$PROJECT_NAME" >&2
            ;;
    esac
}

cleanup_checked() {
    validate_project_name
    compose down --volumes --remove-orphans --rmi local
    CLEANUP_DONE=1
}

handle_exit() {
    exit_status=$?
    trap - EXIT
    cleanup_best_effort
    exit "$exit_status"
}

build_runner() {
    printf '\n构建隔离的 Go 测试 runner...\n'
    compose build runner
}

run_personal_finance_unit_tests() {
    printf '\n运行个人财务普通单元测试...\n'
    compose run --rm --no-deps runner sh -ec '
        go test -buildvcs=false -mod=readonly -count=1 ./pkg/personalfinance/...
    '
}

run_database_update() {
    database_type=$1
    shift

    printf '\n验证 %s：首次建表并重复执行...\n' "$database_type"
    compose run --rm --no-deps \
        -e "EBK_DATABASE_TYPE=$database_type" \
        "$@" \
        runner sh -ec '
            test ! -e /workspace/data
            test ! -e /workspace/log
            test ! -e /workspace/storage
            mkdir -p /testwork/data /testwork/public /testwork/storage
            PF_DB_INTEGRATION=1 go test -buildvcs=false -mod=readonly \
                -tags=pf_db_integration -count=1 -timeout=10m \
                ./pkg/personalfinance/migrations
            PF_DB_INTEGRATION=1 go test -buildvcs=false -mod=readonly \
                -tags=pf_importing_db_integration -count=1 -timeout=10m \
                ./pkg/personalfinance/importing
            go build -buildvcs=false -mod=readonly -o /testwork/ezbookkeeping ./ezbookkeeping.go
            /testwork/ezbookkeeping --conf-path=/workspace/conf/ezbookkeeping.ini --no-boot-log database update
            /testwork/ezbookkeeping --conf-path=/workspace/conf/ezbookkeeping.ini --no-boot-log database update
        '
}

run_sqlite() {
    run_database_update sqlite3 \
        -e EBK_DATABASE_DB_PATH=/testwork/data/ezbookkeeping.db
}

run_mysql() {
    compose up --detach --wait --wait-timeout 180 mysql
    run_database_update mysql \
        -e EBK_DATABASE_HOST=mysql:3306 \
        -e EBK_DATABASE_NAME=ezbookkeeping_pf_test \
        -e EBK_DATABASE_USER=pf_test \
        -e EBK_DATABASE_PASSWD=pf_test_password
}

run_postgres() {
    compose up --detach --wait --wait-timeout 180 postgres
    run_database_update postgres \
        -e EBK_DATABASE_HOST=postgres:5432 \
        -e EBK_DATABASE_NAME=ezbookkeeping_pf_test \
        -e EBK_DATABASE_USER=pf_test \
        -e EBK_DATABASE_PASSWD=pf_test_password \
        -e EBK_DATABASE_SSL_MODE=disable
}

case "$TARGET" in
    sqlite | mysql | postgres | all)
        ;;
    -h | --help)
        show_help
        exit 0
        ;;
    *)
        show_help >&2
        fail "未知目标 $TARGET"
        ;;
esac

command -v docker >/dev/null 2>&1 || fail "找不到 docker"
docker compose version >/dev/null 2>&1 || fail "docker compose 不可用"

validate_project_name

trap handle_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$REPOSITORY_ROOT"
printf '隔离项目：%s\n' "$PROJECT_NAME"
build_runner
run_personal_finance_unit_tests

case "$TARGET" in
    sqlite)
        run_sqlite
        ;;
    mysql)
        run_mysql
        ;;
    postgres)
        run_postgres
        ;;
    all)
        run_sqlite
        run_mysql
        run_postgres
        ;;
esac

cleanup_checked
printf '\n%s 数据库基线验证通过。\n' "$TARGET"
