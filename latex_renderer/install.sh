#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  printf '%s\n' '此安装脚本使用 macOS LaunchAgent；其他平台可直接运行 server.py。' >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python_bin=''
for candidate in /opt/homebrew/bin/python3.12 /usr/local/bin/python3.12 \
  /opt/homebrew/opt/python@3.12/bin/python3.12 /usr/local/opt/python@3.12/bin/python3.12 \
  python3.12 python3.13 python3.11 python3.10 python3.9 python3; do
  resolved=$(command -v "$candidate" 2>/dev/null || true)
  [ -n "$resolved" ] || continue
  # The system Python may require accepting an Xcode license; do not invoke it.
  [ "$resolved" != '/usr/bin/python3' ] || continue
  if "$resolved" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
    python_bin=$resolved
    break
  fi
done

if [ -z "$python_bin" ]; then
  printf '%s\n' '需要可运行的 Python 3.9+，例如先执行 brew install python@3.12。' >&2
  exit 1
fi

exec "$python_bin" "$script_dir/manage.py" install "$@"
