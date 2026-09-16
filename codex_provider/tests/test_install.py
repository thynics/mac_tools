import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest


SOURCE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("installer", SOURCE / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallationTest(unittest.TestCase):
    def test_entries_share_home_preserve_credentials_and_select_distinct_profiles(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / ".codex"
            bin_dir = Path(temporary) / "bin"
            root.mkdir()
            (root / "config.toml").write_text('''model_provider = "openai"
model = "gpt-6-astra"
model_reasoning_effort = "xhigh"
model_context_window = 1050000
[model_providers.nvidia]
name = "Existing provider"
base_url = "http://127.0.0.1:1/v1"
env_key = "NVIDIA_API_KEY"
wire_api = "responses"
''')
            (root / "nvidia.config.toml").write_text('model_reasoning_effort = "ultra"\n')
            (root / ".env").write_text('export NVIDIA_API_KEY="fixture-original-key"\n')
            (root / "auth.json").write_text('{"fixture":"official login preserved"}')
            session = root / "sessions/fixture.jsonl"
            session.parent.mkdir()
            session.write_text('{"type":"session_meta","payload":{"id":"fixture"}}\n')
            protected = {p: p.read_bytes() for p in (root / "config.toml", root / ".env", root / "auth.json", session)}
            installer.install(root, bin_dir)
            (bin_dir / "codex").write_text(
                f"#!{sys.executable}\nimport json, os, sys\n"
                "print(json.dumps({'args':sys.argv[1:], 'home':os.environ.get('CODEX_HOME'), "
                "'credential_matches':os.environ.get('NVIDIA_API_KEY') == 'fixture-original-key'}))\n"
            )
            (bin_dir / "codex").chmod(0o755)
            env = dict(os.environ, CODEX_HOME=str(root), PATH=str(bin_dir) + os.pathsep + os.environ["PATH"])
            env.pop("NVIDIA_API_KEY", None)
            for entry, profile in (("codex-official", "openai"), ("codex-api", "api")):
                result = subprocess.run([str(bin_dir / entry), "--version"], env=env, text=True, capture_output=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                payload = json.loads(result.stdout)
                self.assertEqual(payload["args"][:2], ["--profile", profile])
                self.assertEqual(payload["home"], str(root))
                self.assertEqual(payload["credential_matches"], entry == "codex-api")
                self.assertNotIn("fixture-original-key", result.stdout)
            api = tomllib.loads((root / "api.config.toml").read_text())
            self.assertEqual(api["model"], "openai/openai/eccn-gpt-6-astra")
            self.assertEqual(api["model_reasoning_effort"], "ultra")
            self.assertEqual(api["model_context_window"], 1050000)
            self.assertEqual(api["model_providers"]["nvidia"]["base_url"], "http://127.0.0.1:1/v1")
            for args in (("-p", "other"), ("-c", 'sqlite_home="/tmp/elsewhere"'), ("resume", "--last")):
                result = subprocess.run([str(bin_dir / "codex-api"), *args], env=env, text=True, capture_output=True, timeout=15)
                self.assertNotEqual(result.returncode, 0)
            installer.install(root, bin_dir)
            for path, before in protected.items():
                self.assertEqual(path.read_bytes(), before)
            self.assertNotIn("fixture-original-key", (root / "api.config.toml").read_text())


if __name__ == "__main__":
    unittest.main()
