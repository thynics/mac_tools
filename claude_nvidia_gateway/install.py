#!/usr/bin/env python3
"""Install or remove the current user's Claude NVIDIA gateway LaunchAgent."""

import argparse
import hashlib
import json
import os
import plistlib
import shutil
import socket
import subprocess
from pathlib import Path

LABEL = "com.thynics.claude-nvidia-gateway"
ROOT = Path.home() / "Library/Application Support/Claude-NVIDIA-Gateway"
PLIST = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
LIBRARY = Path.home() / "Library/Application Support/Claude-3p/configLibrary"


def private_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
    temporary.chmod(0o600)
    temporary.replace(path)


def active_config():
    meta = json.loads((LIBRARY / "_meta.json").read_text())
    path = LIBRARY / (meta["appliedId"] + ".json")
    return path, json.loads(path.read_text())


def stop_agent():
    subprocess.run(["launchctl", "bootout", "gui/{}".format(os.getuid()), str(PLIST)],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def install():
    path, settings = active_config()
    key = settings.get("inferenceGatewayApiKey")
    if not key or settings.get("inferenceProvider") != "gateway":
        raise SystemExit("Configure Claude Desktop with the NVIDIA gateway API key first.")
    endpoint = settings.get("inferenceGatewayBaseUrl", "")
    if endpoint != "https://inference-api.nvidia.com" and not endpoint.startswith("http://127.0.0.1:"):
        raise SystemExit("The active Claude configuration uses a different gateway; leaving it unchanged.")
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    ROOT.chmod(0o700)
    backup = ROOT / "original-claude-config.json"
    if not backup.exists():
        private_json(backup, {"path": str(path), "settings": settings})
    previous = ROOT / "gateway-config.json"
    if previous.exists():
        port = json.loads(previous.read_text())["port"]
    else:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
    private_json(previous, {"port": port, "credential_sha256": hashlib.sha256(key.encode()).hexdigest()})
    shutil.copyfile(Path(__file__).with_name("gateway.py"), ROOT / "gateway.py")
    (ROOT / "gateway.py").chmod(0o600)
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "Label": LABEL,
        "ProgramArguments": ["/usr/bin/python3", str(ROOT / "gateway.py"), "--config", str(previous)],
        "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 5,
        "StandardOutPath": str(ROOT / "gateway.log"),
        "StandardErrorPath": str(ROOT / "gateway-error.log"),
        "EnvironmentVariables": {"PYTHONUNBUFFERED": "1"},
    }
    stop_agent()
    PLIST.write_bytes(plistlib.dumps(payload))
    PLIST.chmod(0o600)
    subprocess.run(["launchctl", "bootstrap", "gui/{}".format(os.getuid()), str(PLIST)], check=True)
    settings["inferenceGatewayBaseUrl"] = "http://127.0.0.1:{}".format(port)
    settings["inferenceModels"] = [{
        "name": "claude-opus-5-5", "labelOverride": "Claude Opus 5.5 (NVIDIA)",
        "anthropicFamilyTier": "opus", "isFamilyDefault": True, "maxEffort": "max",
    }]
    private_json(path, settings)
    print("Installed gateway at http://127.0.0.1:{}".format(port))
    print("Restart Claude Desktop to use its native effort selector.")


def uninstall():
    backup = ROOT / "original-claude-config.json"
    if backup.exists():
        original = json.loads(backup.read_text())
        path = Path(original["path"])
        if path.exists():
            current = json.loads(path.read_text())
            original_settings = original["settings"]
            if current.get("inferenceGatewayBaseUrl", "").startswith("http://127.0.0.1:"):
                for key in ("inferenceGatewayBaseUrl", "inferenceModels"):
                    current[key] = original_settings[key]
                private_json(path, current)
    stop_agent()
    PLIST.unlink(missing_ok=True)
    if ROOT.exists():
        shutil.rmtree(ROOT)
    print("Removed gateway and restored the direct NVIDIA model configuration. Restart Claude Desktop.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args()
    uninstall() if args.uninstall else install()
