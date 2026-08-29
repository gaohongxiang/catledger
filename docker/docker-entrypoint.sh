#!/bin/sh

set -e;

conf_path_param="";

if [ "${CATLEDGER_CONF_PATH}" != "" ]; then
  conf_path_param="--conf-path=${CATLEDGER_CONF_PATH}";
fi

if [ $# -gt 0 ]; then
    exec "$@"
else
    exec /catledger/catledger server run ${conf_path_param};
fi
