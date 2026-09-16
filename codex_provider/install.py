#!/usr/bin/env python3
"""Install per-process launchers without changing existing credentials or history."""

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import tomllib


SOURCE = Path(__file__).resolve().parent
SKILL = "codex-provider-switch"


def toml_value(value):
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(
            f"{json.dumps(key)} = {toml_value(item)}" for key, item in value.items()
        ) + " }"
    raise ValueError(f"unsupported TOML value type: {type(value).__name__}")


def render(data):
    text = "\n".join(f"{key} = {toml_value(value)}" for key, value in data.items()) + "\n"
    if tomllib.loads(text) != data:
        raise ValueError("profile serialization changed configuration values")
    return text


def atomic_write(path, text, mode=0o600):
    if path.is_symlink():
        raise ValueError(f"refusing to overwrite symlink: {path}")
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "w") as handle:
            handle.write(text)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install(root, bin_dir):
    base_path = root / "config.toml"
    base = tomllib.loads(base_path.read_text())
    if base.get("model_provider") != "openai" or base.get("model") != "gpt-6-astra":
        raise ValueError("installation expects the existing official gpt-6-astra default")
    provider = base.get("model_providers", {}).get("nvidia")
    if not provider or not provider.get("env_key"):
        raise ValueError("existing NVIDIA provider with env_key authentication is required")
    old_api_path = root / "api.config.toml"
    if not old_api_path.is_file():
        old_api_path = root / "nvidia.config.toml"
    old_api = tomllib.loads(old_api_path.read_text()) if old_api_path.exists() else {}
    official = {key: base[key] for key in (
        "model_provider", "model", "model_reasoning_effort", "model_context_window",
    ) if key in base}
    catalog = json.loads((SOURCE / "catalogs/nvidia-astra.json").read_text())
    entry = catalog["models"][0]
    assert entry["slug"] == "openai/openai/eccn-gpt-6-astra"
    assert entry["use_responses_lite"] is False
    catalog_path = root / "model-catalogs/nvidia-astra.json"
    api = {
        "model_provider": "nvidia",
        "model": entry["slug"],
        "model_reasoning_effort": old_api.get("model_reasoning_effort", base.get("model_reasoning_effort", "xhigh")),
        "model_reasoning_summary": old_api.get("model_reasoning_summary", "none"),
        "model_catalog_json": str(catalog_path),
        "model_context_window": base.get("model_context_window", entry["context_window"]),
        "web_search": "disabled",
        "model_providers": {"nvidia": provider},
    }
    profiles = {"openai.config.toml": render(official), "api.config.toml": render(api)}
    immutable = {p: p.read_bytes() for p in (base_path, root / ".env", root / "auth.json") if p.is_file()}
    skill = root / "skills" / SKILL
    targets = [root / name for name in profiles] + [catalog_path, skill]
    targets += [bin_dir / name for name in ("codex-provider", "codex-api", "codex-official")]
    if any(path.is_symlink() for path in targets):
        raise ValueError("refusing to replace a symlink at an installation target")
    backup = root / "provider-switch-backups" / dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ-before-install")
    backup.mkdir(mode=0o700, parents=True)
    for name in ("config.toml", "nvidia.config.toml", *profiles):
        path = root / name
        if path.is_file():
            shutil.copy2(path, backup / name)
            (backup / name).chmod(0o600)
    if catalog_path.is_file():
        shutil.copy2(catalog_path, backup / "nvidia-astra.json")
    manifest = []
    for directory in ("sessions", "archived_sessions"):
        for path in (root / directory).rglob("*.jsonl"):
            with path.open("rb") as handle:
                identity = hashlib.sha256(handle.readline()).hexdigest()
            manifest.append({"path": str(path.relative_to(root)), "session_meta_sha256": identity})
    atomic_write(backup / "threads.manifest.jsonl", "".join(json.dumps(row) + "\n" for row in manifest))
    bin_dir.mkdir(parents=True, exist_ok=True)
    (backup / "launchers").mkdir(mode=0o700)
    for name in ("codex-provider", "codex-api", "codex-official"):
        path = bin_dir / name
        if path.is_file():
            shutil.copy2(path, backup / "launchers" / name)
    if skill.exists():
        os.replace(skill, backup / "previous-skill")
    skill.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(SOURCE / "skill", skill, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for path in (skill / "scripts").iterdir():
        if path.is_file():
            path.chmod(0o755 if path.name == "codex-provider" else 0o644)
    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(catalog_path, json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
    for name, text in profiles.items():
        atomic_write(root / name, text)
    for name in ("codex-provider", "codex-api", "codex-official"):
        atomic_write(bin_dir / name, (SOURCE / "bin" / name).read_text(), mode=0o755)
    if any(path.read_bytes() != before for path, before in immutable.items()):
        raise RuntimeError("a protected config or credential file changed during installation")
    if any(not (root / row["path"]).is_file() for row in manifest):
        raise RuntimeError("a pre-existing rollout disappeared during installation")
    print(f"Installed codex-official and codex-api in {bin_dir}")
    print(f"Existing base config and credentials preserved; {len(manifest)} rollout files retained")
    print(f"Previous profiles, skill, and launchers backed up to {backup}")
    return backup


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-home", type=Path, default=Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))))
    parser.add_argument("--bin-dir", type=Path, default=Path.home() / ".local/bin")
    args = parser.parse_args()
    install(args.codex_home.expanduser().resolve(), args.bin_dir.expanduser().resolve())
