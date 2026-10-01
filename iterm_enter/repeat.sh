#!/bin/sh
# Keep one process alive so launchd's launch throttling does not set the interval.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
while true; do
    /bin/sh "$script_dir/enter.sh" "$@"
    /bin/sleep 1
done
