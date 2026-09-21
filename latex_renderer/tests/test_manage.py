"""LaunchAgent lifecycle regressions; never touch the actual user's service."""

from contextlib import ExitStack, redirect_stdout
from io import StringIO
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import call, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import manage


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.scope = ExitStack()
        self.addCleanup(self.scope.close)
        root = Path(self.scope.enter_context(tempfile.TemporaryDirectory())).resolve()
        support = root / "Application Support/Paper Studio"
        for name, value in {"SUPPORT": support, "APP": support / "app",
                            "CONFIG": support / "config.json", "PLIST": root / "agent.plist",
                            "LAUNCHER": root / "bin/paper-studio"}.items():
            self.scope.enter_context(patch.object(manage, name, value))
        self.config = manage.defaults()
        manage.APP.mkdir(parents=True)
        (manage.APP / manage.INSTALL_MARKER).write_text("Paper Studio\n")
        (manage.APP / "server.py").write_text("# Test fixture; never executed.\n")
        manage.PLIST.write_bytes(manage.plist_content(self.config))
        self.commands = self.scope.enter_context(patch.object(manage, "launchctl"))
        self.pause = self.scope.enter_context(patch.object(manage.time, "sleep"))

    def test_restart_waits_for_label_removal_before_bootstrap(self):
        # The socket has closed, but launchd still exposes the label for two
        # polls after bootout. Restart must not mistake it for a startable job.
        with patch.object(manage, "loaded", side_effect=[True, True, True, False, False]) as labels, \
             patch.object(manage, "listening", return_value=False), \
             patch.object(manage, "probe", return_value=(None, "not ready")), \
             patch.object(manage, "wait_healthy", return_value={"runtime": {"ready": True}}), \
             patch.object(manage, "read_config", return_value=self.config), \
             patch.object(manage.sys, "platform", "darwin"), redirect_stdout(StringIO()):
            self.assertEqual(manage.main(["restart"]), 0)
        self.assertEqual(labels.call_count, 5)
        self.assertEqual(self.pause.call_count, 2)
        self.assertEqual(self.commands.call_args_list, [
            call("bootout", manage.SERVICE), call("enable", manage.SERVICE),
            call("bootstrap", manage.DOMAIN, str(manage.PLIST)),
        ])

    def test_stop_also_waits_for_port_after_label_disappears(self):
        with patch.object(manage, "loaded", side_effect=[True, False, False]), \
             patch.object(manage, "listening", side_effect=[True, False]):
            self.assertTrue(manage.stop(self.config))
        self.pause.assert_called_once_with(0.1)
        self.commands.assert_called_once_with("bootout", manage.SERVICE)

    def test_stop_reports_label_that_does_not_unload(self):
        with patch.object(manage, "loaded", return_value=True), \
             patch.object(manage, "listening", return_value=False), \
             patch.object(manage.time, "monotonic", side_effect=[0, 10]):
            with self.assertRaisesRegex(manage.CommandError, "标签 .* 尚未卸载"):
                manage.stop(self.config)
        self.commands.assert_called_once_with("bootout", manage.SERVICE)

    def test_stop_reports_port_that_does_not_close(self):
        with patch.object(manage, "loaded", side_effect=[True, False]), \
             patch.object(manage, "listening", return_value=True), \
             patch.object(manage.time, "monotonic", side_effect=[0, 10]):
            with self.assertRaisesRegex(manage.CommandError, "端口 8787 仍被占用"):
                manage.stop(self.config)
        self.commands.assert_called_once_with("bootout", manage.SERVICE)

if __name__ == "__main__":
    unittest.main()
