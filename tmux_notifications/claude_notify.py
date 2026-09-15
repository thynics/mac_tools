#!/usr/bin/env python3
"""Return an iTerm notification for a Claude Stop hook in tmux -CC workspace."""

import json
import os
import re
import subprocess
import sys


def clean(value, limit):
    # Remove terminal controls before embedding untrusted names or reply text.
    text = "".join(c for c in str(value or "") if c.isprintable() or c.isspace())
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def notification(event):
    if event.get("hook_event_name") != "Stop" or event.get("agent_id"):
        return {}
    pane = os.environ.get("TMUX_PANE", "")
    if not os.environ.get("TMUX") or not re.fullmatch(r"%[0-9]+", pane):
        return {}
    info = subprocess.check_output(
        ["tmux", "display-message", "-p", "-t", pane,
         "#{session_name}\t#{window_index}.#{pane_index}\t#{window_name}"],
        text=True, timeout=2, stderr=subprocess.DEVNULL,
    ).strip().split("\t", 2)
    if len(info) != 3 or info[0] != "workspace":
        return {}
    session, index, name = info
    label = clean(f"{session}:{index} {name}", 100)
    reply = clean(event.get("last_assistant_message"), 140)
    message = f"Claude · {label} · 回复完成"
    if reply:
        message += f"：{reply}"
    return {"terminalSequence": f"\x1b]9;{message}\x07"}


if __name__ == "__main__":
    try:
        result = notification(json.load(sys.stdin))
    except (ValueError, TypeError, AttributeError, OSError, subprocess.SubprocessError):
        result = {}
    # Hook failures must never interrupt or prolong Claude's work.
    print(json.dumps(result, ensure_ascii=True))
