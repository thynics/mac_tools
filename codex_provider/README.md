# Codex provider entrypoints

macOS adaptation of the haifa provider launcher. `codex-official` uses the existing
ChatGPT login and `codex-api` uses NVIDIA's Astra model with the existing API key.
Both use the same Codex home and task history. No persistent provider toggling.

Install with Python 3.11+:

```sh
/opt/homebrew/bin/python3.12 install.py
codex-provider status
codex-provider verify
```

The installer expects an existing official default and `[model_providers.nvidia]`
configuration. It preserves `config.toml`, `.env`, `auth.json`, and sessions;
backs up replaced profiles, skill files, and launchers; and writes separate
`api.config.toml` and `openai.config.toml` profiles. API effort is preserved from
the old NVIDIA profile; official model, effort, and context stay unchanged.

The API bridge removes unsupported `client_metadata` while retaining instructions,
terminal tools, reasoning, and streaming. API web search and Responses Lite are
disabled to match the NVIDIA gateway. Existing credentials are never bundled.

Validation:

```sh
/opt/homebrew/bin/python3.12 -m unittest discover -s tests -v
/opt/homebrew/bin/python3.12 ~/.codex/skills/codex-provider-switch/scripts/test_api_responses_compat.py
```
