#!/usr/bin/env python3
"""Local-only candidate generation tests; no service/controller interaction."""

import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parent.parent / "proxy-dns.py"
SPEC = importlib.util.spec_from_file_location("proxy_dns", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

PREFIX = "mixed-port: 8119\n# Preserve the pre-DNS comment.\n"
SUFFIX = "\n# These hosts must stay untouched.\nhosts:\n  nv: nv.nvidia.com\nrules:\n  - MATCH,AUTO\n"
CONFIG = PREFIX + "dns:\n  enable: false\n  # An old DNS-only setting.\n  ipv6: true\n" + SUFFIX
LEGACY = (SCRIPT.parent / "tests/fixtures/legacy.yaml").read_text()


class CandidateTests(unittest.TestCase):
    def test_preserves_other_fields_and_comments(self):
        result = MODULE.replace_dns_block(CONFIG, "10.19.185.31,10.19.180.31")
        self.assertTrue(result.startswith(PREFIX))
        self.assertTrue(result.endswith(SUFFIX))
        self.assertIn('  listen: ""\n', result)
        self.assertIn("  nameserver: [system]\n  direct-nameserver: [system]\n", result)
        self.assertIn("    - tcp://10.19.185.31\n    - tcp://10.19.180.31\n", result)
        self.assertNotIn("An old DNS-only setting", result)

    def test_repeated_generation_is_idempotent(self):
        once = MODULE.replace_dns_block(CONFIG, "10.19.185.31,10.19.180.31")
        self.assertEqual(once, MODULE.replace_dns_block(once, "10.19.185.31,10.19.180.31"))

    def test_ipv6_brackets_and_duplicate_elimination(self):
        result = MODULE.replace_dns_block(CONFIG, " 2001:0db8::1, 10.19.185.31,2001:db8::1 ")
        self.assertEqual(result.count("tcp://[2001:db8::1]"), 1)
        self.assertEqual(result.count("tcp://10.19.185.31"), 1)

    def test_empty_list_falls_back_to_system(self):
        result = MODULE.replace_dns_block(CONFIG, "  ")
        self.assertIn("  proxy-server-nameserver: [system]\n", result)
        self.assertNotIn("tcp://", result)

    def test_crlf_bytes_outside_dns_are_unchanged(self):
        original = CONFIG.replace("\n", "\r\n")
        result = MODULE.replace_dns_block(original, "10.19.185.31")
        self.assertTrue(result.startswith(PREFIX.replace("\n", "\r\n")))
        self.assertTrue(result.endswith(SUFFIX.replace("\n", "\r\n")))
        self.assertNotIn("\n", result.replace("\r\n", ""))

    def test_nested_dns_does_not_count_as_top_level(self):
        prefix = "profile:\n  dns:\n    untouched: true\n"
        result = MODULE.replace_dns_block(prefix + CONFIG, "10.19.185.31")
        self.assertTrue(result.startswith(prefix + PREFIX))

    def test_missing_or_duplicate_dns_rejected(self):
        for text in ["mixed-port: 8119\n", CONFIG + "dns:\n  enable: false\n", CONFIG + '"dns":\n  enable: false\n']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                MODULE.replace_dns_block(text, "10.19.185.31")

    def test_ambiguous_yaml_rejected(self):
        for text in ["dns: {enable: false}\n", "dns: &shared\n  enable: false\n", "---\n" + CONFIG, CONFIG + "? dns\n: {}\n", "dns:\n\tenable: false\n"]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                MODULE.replace_dns_block(text, "10.19.185.31")

    def test_invalid_ip_lists_rejected(self):
        for value in ["bad-host", "1.2.3.999", "1.2.3.4,", ",1.2.3.4", "1.2.3.4,,5.6.7.8", "tcp://1.2.3.4", "1.2.3.4:53", "fe80::1%en0"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                MODULE.replace_dns_block(CONFIG, value)

    def test_cli_writes_candidate_and_preserves_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "source.yaml", Path(directory) / "candidate.yaml"
            source.write_bytes(CONFIG.encode())
            call = subprocess.run([sys.executable, str(SCRIPT), str(source), "10.19.185.31", "--output", str(target)], capture_output=True, text=True)
            self.assertEqual(call.returncode, 0, call.stderr)
            self.assertEqual(call.stdout.strip(), str(target))
            self.assertEqual(source.read_bytes(), CONFIG.encode())
            self.assertEqual(target.read_text(), MODULE.replace_dns_block(CONFIG, "10.19.185.31"))
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_invalid_input_leaves_existing_output_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "source.yaml", Path(directory) / "candidate.yaml"
            source.write_text(CONFIG)
            target.write_text("sentinel")
            with self.assertRaises(ValueError):
                MODULE.generate_candidate(source, "not-an-ip", target)
            self.assertEqual(target.read_text(), "sentinel")
            source.write_text(CONFIG + "dns:\n  enable: false\n")
            with self.assertRaises(ValueError):
                MODULE.generate_candidate(source, "10.19.185.31", target)
            self.assertEqual(target.read_text(), "sentinel")
            self.assertEqual(sorted(p.name for p in Path(directory).iterdir()), ["candidate.yaml", "source.yaml"])

    def test_input_path_and_symlink_outputs_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "source.yaml", Path(directory) / "candidate.yaml"
            source.write_text(CONFIG)
            with self.assertRaises(ValueError):
                MODULE.generate_candidate(source, "", source)
            target.symlink_to(source)
            with self.assertRaises(ValueError):
                MODULE.generate_candidate(source, "", target)
            self.assertEqual(source.read_text(), CONFIG)


class RoutingTests(unittest.TestCase):
    def test_openai_cannot_follow_auto_to_direct(self):
        result = MODULE.stabilize_routing(LEGACY)
        for domain in ("openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com"):
            self.assertIn("  - DOMAIN-SUFFIX,{},KIX\n".format(domain), result)
        self.assertLess(result.index("DOMAIN-SUFFIX,openai.com,KIX"), result.index("MATCH,AUTO"))
        self.assertIn("      - KIX\n      - DIRECT\n", result)

    def test_non_443_traffic_bypasses_kix(self):
        result = MODULE.stabilize_routing(LEGACY)
        self.assertLess(result.index("NOT,((DST-PORT,443)),DIRECT"), result.index("MATCH,AUTO"))

    def test_company_and_login_routes_unchanged(self):
        result = MODULE.stabilize_routing(LEGACY)
        for rule in ("DOMAIN-SUFFIX,nvidia.com,DIRECT", "DOMAIN-SUFFIX,microsoftonline.com,DIRECT", "IP-CIDR,127.0.0.0/8,DIRECT,no-resolve"):
            self.assertIn(rule, result)
        self.assertEqual(result[:result.index("proxy-groups:")], LEGACY[:LEGACY.index("proxy-groups:")])

    def test_region_errors_are_not_healthy(self):
        result = MODULE.stabilize_routing(LEGACY)
        kix = result[result.index("  - name: KIX"):result.index("  - name: AUTO")]
        self.assertIn("    expected-status: 401\n", kix)
        self.assertIn("    lazy: false\n", kix)
        self.assertIn("    interval: 60\n", kix)
        self.assertEqual(result.count("    max-failed-times: 5\n"), 2)

    def test_repeated_refresh_does_not_duplicate_rules(self):
        once = MODULE.stabilize_routing(LEGACY)
        self.assertEqual(once, MODULE.stabilize_routing(once))
        with_dns = MODULE.replace_dns_block(once, "10.0.0.53")
        self.assertEqual(with_dns, MODULE.stabilize_routing(with_dns))

    def test_crlf_is_preserved(self):
        result = MODULE.stabilize_routing(LEGACY.replace("\n", "\r\n"))
        self.assertNotIn("\n", result.replace("\r\n", ""))

    def test_unsafe_or_ambiguous_groups_rejected(self):
        for text in (LEGACY.replace("      - KIX-10", "      - DIRECT"),
                     LEGACY.replace("    type: fallback", "    type: select", 1),
                     LEGACY.replace("    lazy: true", "    lazy: true\n    lazy: false"),
                     LEGACY.replace("  - name: KIX", "  - name: OTHER"),
                     LEGACY + "rules:\n  - MATCH,DIRECT\n",
                     LEGACY.replace("  - MATCH,AUTO", "  - MATCH,DIRECT")):
            with self.subTest(text=text), self.assertRaises(ValueError):
                MODULE.stabilize_routing(text)

    def test_incomplete_managed_rules_rejected(self):
        text = MODULE.stabilize_routing(LEGACY).replace("  # END codex-proxy-guard\n", "")
        with self.assertRaises(ValueError):
            MODULE.stabilize_routing(text)

    def test_stabilizing_cli_and_mihomo_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "source.yaml", Path(directory) / "candidate.yaml"
            source.write_text(LEGACY)
            call = subprocess.run([sys.executable, str(SCRIPT), str(source), "", "--stabilize-routing", "--output", str(target)], capture_output=True, text=True)
            self.assertEqual(call.returncode, 0, call.stderr)
            self.assertEqual(source.read_text(), LEGACY)
            self.assertIn("DOMAIN-SUFFIX,openai.com,KIX", target.read_text())
            import shutil
            binary = shutil.which("mihomo")
            if binary:
                check = subprocess.run([binary, "-t", "-d", directory, "-f", str(target)], capture_output=True, text=True)
                self.assertEqual(check.returncode, 0, check.stdout + check.stderr)


if __name__ == "__main__":
    unittest.main()
