---
name: codex-provider-switch
description: Launch local Codex through official ChatGPT or the saved NVIDIA API provider, inspect configuration, or resume the same task UUID with another provider. Uses per-process profiles and one shared Codex home; does not change the provider of an already-running task or rotate credentials.
---

# Codex Provider Switch

Use the installed commands:

```bash
codex-provider                         # status, including credential presence only
codex-official                         # official ChatGPT login, gpt-6-astra
codex-api                              # existing NVIDIA API key, GPT-6 Astra
codex-official resume <THREAD_UUID>
codex-api resume <THREAD_UUID>
codex-provider threads --limit 30       # root tasks by default
codex-provider handoff api              # print the current task's resume command
codex-provider verify                  # offline profile and shared-skill checks
```

The helpers select `openai.config.toml` or `api.config.toml` under the existing
`CODEX_HOME` (normally `~/.codex`). Both share skills, task history, attachments,
and databases. Launching either entry does not rewrite `config.toml`. Bare
`codex` and the desktop app retain the official default. These commands replace
the older persistent `switch`/`toggle` workflow.

The Mac entrypoints choose Python 3.11+ independently of Apple's system Python.
The launcher discovers Codex on PATH or in the installed Codex/ChatGPT app.

## Credentials and configuration

Keep the API provider's existing `base_url`, `env_key`, and credentials. The API
helper reads its credential from the environment, or that same variable in the
existing `CODEX_HOME/.env` if absent. It does not execute the dotenv file, copy
the key into profiles, or rewrite `.env` or `auth.json`. Do not print key values.
Official launches use the existing ChatGPT login. Never log out or rotate keys
as part of provider switching.

The API model is `openai/openai/eccn-gpt-6-astra`. Its profile uses a dedicated
catalog with `use_responses_lite = false`; otherwise this gateway receives no
instructions or terminal tools. Built-in web search is disabled only in the API
profile because the gateway rejects `web_search_options`.

`scripts/api_responses_compat.py` runs a per-launch loopback bridge for API
processes. It removes top-level `client_metadata` rejected by the NVIDIA
gateway, preserves tools and reasoning, streams responses, and forwards errors.
The bridge uses an ephemeral local credential and closes with the launched CLI.
Never write the upstream key into command arguments, logs, or repository files.
Keep bridge overrides inside the selected CLI subcommand, including `exec resume`.

The shared base retains the official model, effort, and existing official
context-window override. API-specific model/catalog/web settings belong in
`api.config.toml`. Do not introduce a separate CODEX_HOME or SQLite directory.

## Resume and verification

Finish the current turn and exit before resuming the same UUID through another
entry. The helper rejects active writers, archived tasks, missing rollout files,
and provider/thread-store overrides. Resume by explicit UUID, not `--last`.
Routine switching must not move, edit, delete, or fork task history.

After changing profiles or updating Codex, run `codex-provider verify` and:

```bash
/opt/homebrew/bin/python3.12 ~/.codex/skills/codex-provider-switch/scripts/test_api_responses_compat.py
```

These checks use local probes and do not spend API quota. The request probe must
observe instructions and terminal tools; a text-only reply does not prove tool
support. For requested online testing, use a disposable task and verify an actual
terminal call, including after resume when testing handoff. Preserve existing
tasks and report any pre-existing missing-rollout records without removing them.
