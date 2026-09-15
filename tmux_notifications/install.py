#!/usr/bin/env python3
"""Install notification settings on the host running tmux (Python 3.11+)."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import tempfile
import tomllib


def write_backed_up(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text() == content:
        return
    if path.exists():
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup = path.with_name(path.name + ".before-tmux-notifications-" + stamp)
        shutil.copy2(path, backup)
        print(f"Backup: {backup}")
    mode = (path.stat().st_mode & 0o777) if path.exists() else 0o600
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(content)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(f"Updated: {path}")


def codex_settings(text):
    before = tomllib.loads(text)
    desired = {
        "notifications": ["agent-turn-complete"],
        "notification_method": "osc9",
        "notification_condition": "always",
    }
    # Use an existing conventional [tui] table, or append one. The TOML parser
    # checks for conflicting inline/dotted forms before anything is written.
    table = re.search(r"(?m)^\[tui\][ \t]*(?:#.*)?$", text)
    if table:
        start = table.end()
        following = re.search(r"(?m)^\s*\[", text[start:])
        end = start + following.start() if following else len(text)
        block = text[start:end]
        for key, value in desired.items():
            pattern = rf"(?m)^[ \t]*{key}[ \t]*=.*$"
            replacement = f"{key} = {json.dumps(value)}"
            if re.search(pattern, block):
                block = re.sub(pattern, lambda _: replacement, block)
            else:
                block = block.rstrip() + "\n" + replacement + "\n"
        result = text[:start] + block + "\n" + text[end:]
    else:
        result = text.rstrip() + "\n\n# iTerm tmux completion notifications\n[tui]\n"
        result += "".join(f"{key} = {json.dumps(value)}\n" for key, value in desired.items())
    expected = dict(before)
    expected["tui"] = {**before.get("tui", {}), **desired}
    if tomllib.loads(result) != expected:
        raise ValueError("Refusing a change that would alter unrelated Codex settings")
    return result


def main():
    home = Path.home()
    codex = Path(os.environ.get("CODEX_HOME", str(home / ".codex"))) / "config.toml"
    claude = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(home / ".claude"))) / "settings.json"
    helper = home / ".local/share/mac_tools/tmux_notifications/claude_notify.py"
    codex_text = codex_settings(codex.read_text() if codex.exists() else "")
    settings = json.loads(claude.read_text()) if claude.exists() else {}
    command = f"/usr/bin/python3 {shlex.quote(str(helper))}"
    hooks = settings.setdefault("hooks", {}).setdefault("Stop", [])
    if not any(h.get("command") == command for group in hooks for h in group.get("hooks", [])):
        hooks.append({"hooks": [{"type": "command", "command": command, "timeout": 5}]})
    # Prepare and validate both configurations before writing anything.
    claude_text = json.dumps(settings, ensure_ascii=False, indent=2) + "\n"
    helper_text = Path(__file__).with_name("claude_notify.py").read_text()
    compile(helper_text, str(helper), "exec")
    write_backed_up(helper, helper_text)
    write_backed_up(codex, codex_text)
    write_backed_up(claude, claude_text)


if __name__ == "__main__":
    main()
