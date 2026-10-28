#!/usr/bin/env python3
"""Use HTTP Responses with the existing ChatGPT login (Python 3.11+).

The built-in openai provider ignores supports_websockets overrides in current
Codex builds. A distinct provider ID is required; its OpenAI name, auth, models,
tools and destination remain first-party. Running sessions must be resumed.
"""
import argparse
import datetime
import os
from pathlib import Path
import re
import tempfile
import tomllib

PROVIDER = {
    "name": "OpenAI",
    "wire_api": "responses",
    "requires_openai_auth": True,
    "supports_websockets": False,
    "supports_standalone_web_search": True,
}


def http_config(text, define_provider=True):
    original = tomllib.loads(text)
    if original.get("model_provider", "openai") not in ("openai", "openai_http"):
        raise ValueError("Only an existing official OpenAI configuration can be converted")
    existing = original.get("model_providers", {}).get("openai_http")
    if existing is not None and existing != PROVIDER:
        raise ValueError("An incompatible openai_http provider already exists")
    newline = "\r\n" if "\r\n" in text else "\n"
    table = re.search(r"^\[", text, re.M)
    end = table.start() if table else len(text)
    root, remainder = text[:end], text[end:]
    root, count = re.subn(r'''^(\s*model_provider\s*=\s*)(?:"[^"]*"|'[^']*')''',
                          r'\1"openai_http"', root, flags=re.M)
    if count > 1:
        raise ValueError("Ambiguous model_provider entries")
    if not count:
        root = 'model_provider = "openai_http"' + newline + root
    result = root + remainder
    if define_provider and existing is None:
        lines = ['[model_providers.openai_http]']
        for key, value in PROVIDER.items():
            literal = ('true' if value else 'false') if isinstance(value, bool) else '"' + value + '"'
            lines.append(key + ' = ' + literal)
        result = result.rstrip("\r\n") + newline * 2 + newline.join(lines) + newline
    expected = dict(original)
    expected["model_provider"] = "openai_http"
    if define_provider:
        expected["model_providers"] = dict(expected.get("model_providers", {}))
        expected["model_providers"]["openai_http"] = PROVIDER
    if tomllib.loads(result) != expected:
        raise ValueError("Unrelated configuration fields would change")
    return result


def compatible_launcher(text):
    """Keep the installed official/API launcher's strict layout checks usable."""
    if 'def configured_official_provider(' in text:
        return text
    marker = 'def validate_layout(root: Path) -> list[str]:\n'
    if marker not in text:
        raise ValueError('Unknown codex-provider launcher layout; no files replaced')
    function = '''def configured_official_provider(base: dict) -> str:
    expected = {
        "name": "OpenAI", "wire_api": "responses",
        "requires_openai_auth": True, "supports_websockets": False,
        "supports_standalone_web_search": True,
    }
    if (base.get("model_provider") == "openai_http"
            and base.get("model_providers", {}).get("openai_http") == expected):
        return "openai_http"
    return "openai"


'''
    replacements = [
        ('    if base.get("model_provider") != "openai":',
         '    if base.get("model_provider") != configured_official_provider(base):'),
        ('    for alias, expected_provider in PROVIDER_IDS.items():\n',
         '    for alias, expected_provider in PROVIDER_IDS.items():\n'
         '        if alias == "official":\n'
         '            expected_provider = configured_official_provider(base)\n'),
        ('        records = [record for record in records if record["provider"] == expected]',
         '        allowed = {expected}\n'
         '        if args.provider == "official":\n'
         '            allowed.add(configured_official_provider(read_toml(root / "config.toml")))\n'
         '        records = [record for record in records if record["provider"] in allowed]'),
    ]
    for before, after in replacements:
        if text.count(before) != 1:
            raise ValueError('Unknown codex-provider launcher checks; no files replaced')
        text = text.replace(before, after)
    text = text.replace(marker, function + marker)
    compile(text, 'codex-provider', 'exec')
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Back up and atomically update the configuration')
    args = parser.parse_args()
    codex_dir = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
    config = codex_dir / 'config.toml'
    profile = codex_dir / 'openai.config.toml'
    sources = [(config, True)] + ([(profile, False)] if profile.is_file() else [])
    prepared = []
    for path, define in sources:
        if path.is_symlink():
            raise ValueError('Refusing to replace a symlink: ' + str(path))
        raw = path.read_bytes()
        updated = http_config(raw.decode(), define).encode()
        if raw != updated:
            prepared.append((path, raw, updated))
    launcher = codex_dir / 'skills/codex-provider-switch/scripts/codex-provider'
    if launcher.is_file():
        raw = launcher.read_bytes()
        updated = compatible_launcher(raw.decode()).encode()
        if raw != updated:
            prepared.append((launcher, raw, updated))
    if not prepared:
        print('HTTP Responses is already configured. Running sessions must be resumed to pick it up.')
        return
    if not args.apply:
        print('Would update: ' + ', '.join(str(path) for path, _, _ in prepared))
        return
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = codex_dir / 'backups' / ('http-transport-' + stamp + '-' + str(os.getpid()))
    backup.mkdir(parents=True, mode=0o700)
    for path, raw, updated in prepared:
        saved = backup / path.name
        saved.write_bytes(raw)
        saved.chmod(0o600)
        candidate = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.http-config-', delete=False) as stream:
                candidate = Path(stream.name)
                stream.write(updated)
                stream.flush()
                os.fsync(stream.fileno())
            if path.read_bytes() != raw:
                raise RuntimeError('Configuration changed concurrently; retry: ' + str(path))
            candidate.chmod(path.stat().st_mode & 0o777)
            os.replace(candidate, path)
            candidate = None
        finally:
            if candidate is not None:
                candidate.unlink(missing_ok=True)
        print('Updated: ' + str(path))
    print('Backup: ' + str(backup))
    print('Existing ChatGPT login and model settings preserved. Resume running sessions to activate HTTP.')


if __name__ == '__main__':
    main()
