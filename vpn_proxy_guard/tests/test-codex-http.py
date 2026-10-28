import importlib.util
from pathlib import Path
import sys
import tomllib
import unittest

sys.dont_write_bytecode = True
script = Path(__file__).resolve().parent.parent / 'enable-codex-http.py'
spec = importlib.util.spec_from_file_location('http_config', script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ConfigTests(unittest.TestCase):
    def test_preserves_model_auth_and_other_provider(self):
        text = '''model_provider = "openai" # official account
model = "gpt-6-astra"
model_reasoning_effort = "xhigh"
[model_providers.nvidia]
base_url = "https://example.invalid/v1"
env_key = "EXAMPLE_KEY"
'''
        result = module.http_config(text)
        parsed = tomllib.loads(result)
        self.assertEqual(parsed['model'], 'gpt-6-astra')
        self.assertEqual(parsed['model_reasoning_effort'], 'xhigh')
        self.assertEqual(parsed['model_providers']['nvidia'], tomllib.loads(text)['model_providers']['nvidia'])
        self.assertTrue(parsed['model_providers']['openai_http']['requires_openai_auth'])
        self.assertFalse(parsed['model_providers']['openai_http']['supports_websockets'])
        self.assertIn('# official account', result)

    def test_idempotent(self):
        once = module.http_config('model_provider = "openai"\n')
        self.assertEqual(once, module.http_config(once))

    def test_official_profile_inherits_base_provider(self):
        parsed = tomllib.loads(module.http_config('model_provider = "openai"\nmodel = "gpt-6-astra"\n', False))
        self.assertEqual(parsed, {'model_provider': 'openai_http', 'model': 'gpt-6-astra'})

    def test_does_not_replace_another_vendor(self):
        with self.assertRaises(ValueError):
            module.http_config('model_provider = "nvidia"\n')

    def test_provider_conflict_rejected(self):
        with self.assertRaises(ValueError):
            module.http_config('[model_providers.openai_http]\nname="Other"\n')

    def test_nested_profile_selection_is_preserved(self):
        parsed = tomllib.loads(module.http_config('[profiles.example]\nmodel_provider="nvidia"\n'))
        self.assertEqual(parsed['model_provider'], 'openai_http')
        self.assertEqual(parsed['profiles']['example']['model_provider'], 'nvidia')


if __name__ == '__main__':
    unittest.main()
