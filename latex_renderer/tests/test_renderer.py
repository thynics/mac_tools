"""Behavioral regression checks; no TeX distribution or third-party Python needed."""

from __future__ import annotations

import http.client
import io
import json
from pathlib import Path
import stat
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import Store, TexRuntime, UserError
from server import PaperServer


DOCUMENT = r"\documentclass{article}\begin{document}Hello paper\end{document}"


def archive(files):
    memory = io.BytesIO()
    with zipfile.ZipFile(memory, "w", zipfile.ZIP_DEFLATED) as output:
        for name, content in files.items():
            output.writestr(name, content)
    return memory.getvalue()


def wait_until(predicate, timeout=6):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if result := predicate():
            return result
        time.sleep(0.025)
    raise AssertionError("Timed out waiting for background worker")


class RendererTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        binaries = self.root / "bin"
        binaries.mkdir()
        self.invocations = self.root / "invocations.txt"
        # This controllable compiler exercises the queue, process timeout, file
        # preservation and final-pass diagnostics without needing TeX in CI.
        compiler = binaries / "latexmk"
        compiler.write_text(f"#!{sys.executable}\n" + textwrap.dedent(f'''\
            from pathlib import Path
            import sys, time
            main = Path(sys.argv[-1])
            text = main.read_text()
            with Path({str(self.invocations)!r}).open("a") as calls:
                calls.write("compile\\n")
            assert "-norc" in sys.argv and "-no-shell-escape" in sys.argv
            print("LaTeX Warning: First pass has undefined references.", flush=True)
            if "PAUSE" in text:
                time.sleep(30)
            if "FAIL" in text:
                print("main.tex:2: Undefined control sequence.", flush=True)
                raise SystemExit(1)
            output = Path("paper-studio-output")
            (output / (main.stem + ".log")).write_text("Class article Warning: Final warning only.\\n")
            (output / (main.stem + ".pdf")).write_bytes(b"%PDF-1.4\\n" + text.encode() + b"\\n%%EOF\\n")
            # A compiler can touch its working tree; the imported original must
            # stay unchanged because compilation runs in a disposable copy.
            main.write_text("compiler touched its snapshot")
            '''))
        compiler.chmod(0o755)
        for name in ("pdflatex", "xelatex", "lualatex"):
            engine = binaries / name
            engine.write_text("#!/bin/sh\necho 'pdfTeX test runtime'\n")
            engine.chmod(0o755)
        self.runtime = TexRuntime(str(binaries))
        self.store = Store(self.root / "data", self.runtime)

    def tearDown(self):
        self.store.close()
        self.temporary.cleanup()

    def import_paper(self, content=DOCUMENT):
        return self.store.import_zip(archive({"main.tex": content}), "Example.zip")

    def build(self, project_id):
        self.store.compile(project_id)
        return wait_until(lambda: (p if (p := self.store.describe(project_id))["build"]["status"] not in {"queued", "running"} else None))

    def test_wrapped_zip_readme_main_and_original_bytes(self):
        files = {"export/README.md": "The Overleaf root document is `sigconf.tex`.",
                 "export/main.tex": DOCUMENT, "export/sigconf.tex": DOCUMENT + "\n% original",
                 "export/figures/chart.pdf": b"%PDF-test", "export/abstract.tex": "abstract"}
        project = self.store.import_zip(archive(files), "my-paper.zip")
        self.assertEqual(project["main_file"], "sigconf.tex")
        self.assertEqual(project["name"], "my-paper")
        for name, content in files.items():
            actual = (Path(project["root"]) / name.removeprefix("export/")).read_bytes()
            self.assertEqual(actual, content.encode() if isinstance(content, str) else content)

    def test_comment_documentclass_does_not_select_template(self):
        project = self.store.import_zip(archive({"main.tex": "% " + DOCUMENT, "actual.tex": DOCUMENT}), "paper")
        self.assertEqual(project["main_file"], "actual.tex")

    def test_rejects_traversal_and_leaves_no_project(self):
        for unsafe in ("../escape.tex", "/absolute.tex", "a/../../escape.tex", "a\\escape.tex", "C:/escape.tex"):
            with self.subTest(path=unsafe), self.assertRaises(UserError):
                self.store.import_zip(archive({unsafe: DOCUMENT}), "bad.zip")
        self.assertEqual(self.store.list_projects(), [])
        self.assertFalse((self.root / "escape.tex").exists())

    def test_rejects_symlink_and_case_collision(self):
        memory = io.BytesIO()
        with zipfile.ZipFile(memory, "w") as output:
            item = zipfile.ZipInfo("main.tex")
            item.create_system = 3
            item.external_attr = (stat.S_IFLNK | 0o777) << 16
            output.writestr(item, "/etc/passwd")
        with self.assertRaises(UserError):
            self.store.import_zip(memory.getvalue(), "bad.zip")
        with self.assertRaises(UserError):
            self.store.import_zip(archive({"main.tex": DOCUMENT, "MAIN.tex": DOCUMENT}), "bad.zip")

    def test_invalid_and_expanded_zip_limits(self):
        with self.assertRaises(UserError):
            self.store.import_zip(b"not a zip", "bad.zip")
        with self.assertRaises(UserError):
            self.store.import_zip(archive({"readme.txt": "no document"}), "bad.zip")
        with patch("core.MAX_EXPANDED", 16), self.assertRaises(UserError):
            self.import_paper()
        self.assertEqual(list(self.store.projects_dir.iterdir()), [])

    def test_failed_compile_preserves_pdf_and_source(self):
        project = self.import_paper()
        result = self.build(project["id"])
        self.assertEqual(result["build"]["status"], "success")
        self.assertFalse(result["build"]["source_changed"])
        self.assertEqual(result["build"]["warnings"], ["Class article Warning: Final warning only."])
        source = Path(project["root"]) / "main.tex"
        self.assertEqual(source.read_text(), DOCUMENT)
        pdf = self.store.pdf_path(project["id"]).read_bytes()
        built_at = result["build"]["pdf_built_at"]
        source.write_text("FAIL")
        result = self.build(project["id"])
        self.assertEqual(result["build"]["status"], "error")
        self.assertTrue(result["build"]["source_changed"])
        self.assertEqual(result["build"]["pdf_built_at"], built_at)
        self.assertEqual(self.store.pdf_path(project["id"]).read_bytes(), pdf)
        self.assertIn("Undefined control sequence", self.store.read_log(project["id"]))
        self.assertFalse(list(self.store.project_dir(project["id"]).glob("compile-*")))

    def test_duplicate_queue_and_timeout_release_worker(self):
        project = self.import_paper("PAUSE")
        self.store.timeout = 0.15
        self.store.compile(project["id"])
        with self.assertRaises(UserError) as caught:
            self.store.compile(project["id"])
        self.assertEqual(caught.exception.status, 409)
        wait_until(lambda: self.store.describe(project["id"])["build"]["status"] == "error")
        self.assertIn("超过", self.store.describe(project["id"])["build"]["error"])
        (Path(project["root"]) / "main.tex").write_text(DOCUMENT)
        self.store.timeout = 5
        self.assertEqual(self.build(project["id"])["build"]["status"], "success")

    def test_settings_and_source_access_validation(self):
        project = self.import_paper()
        for changes in ({"watch": "yes"}, {"engine": []}, {"main_file": "../secret.tex"}, {"engine": "unknown"}):
            with self.subTest(changes=changes), self.assertRaises(UserError):
                self.store.update(project["id"], changes)
        with self.assertRaises(UserError):
            self.store.read_source(project["id"], "../project.json")
        self.assertEqual(self.store.read_source(project["id"], "main.tex"), DOCUMENT)

    def test_editor_locks_are_ignored_and_one_bad_project_stays_isolated(self):
        project = self.import_paper()
        source = Path(project["root"])
        (source / ".#main.tex").symlink_to("user@host.123")
        self.assertIsNone(self.store.describe(project["id"])["source_error"])
        good = self.import_paper(DOCUMENT + " another project")
        (source / "unsafe.tex").symlink_to("/etc/passwd")
        listed = {p["id"]: p for p in self.store.list_projects()}
        self.assertIsNone(listed[good["id"]]["source_error"])
        self.assertIn("符号链接", listed[project["id"]]["source_error"])

    def test_watcher_compiles_changes_once_and_does_not_retry_error(self):
        project = self.import_paper()
        self.build(project["id"])
        self.store.update(project["id"], {"watch": True})
        (Path(project["root"]) / "main.tex").write_text("FAIL changed document")
        wait_until(lambda: self.store.describe(project["id"])["build"]["status"] == "error")
        calls = self.invocations.read_text().count("compile")
        # More than two watch intervals: an unchanged failing source must not loop.
        self.store.stop_event.wait(2)
        self.assertEqual(self.invocations.read_text().count("compile"), calls)
        (Path(project["root"]) / "main.tex").write_text(DOCUMENT + " corrected")
        wait_until(lambda: self.store.describe(project["id"])["build"]["status"] == "success")
        self.assertFalse(self.store.describe(project["id"])["build"]["source_changed"])

    def test_restart_keeps_pdf_and_marks_interrupted_build(self):
        project = self.import_paper()
        self.build(project["id"])
        self.store.projects[project["id"]]["build"]["status"] = "running"
        self.store._save(self.store.projects[project["id"]])
        self.store.close()
        self.store = Store(self.root / "data", self.runtime)
        restored = self.store.describe(project["id"])
        self.assertEqual(restored["build"]["status"], "error")
        self.assertTrue(restored["build"]["pdf_url"])


class HTTPBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temporary.name), TexRuntime(), start_workers=False)
        self.server = PaperServer(("127.0.0.1", 0), self.store)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.store.close()
        self.temporary.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(method, path, body, headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_host_and_write_tokens_block_cross_site_requests(self):
        status, _, data = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        state = json.loads(data)
        self.assertEqual(state["app"], "paper-studio")
        self.assertEqual(self.request("GET", "/api/state", headers={"Host": "evil.example"})[0], 403)
        payload = archive({"main.tex": DOCUMENT})
        self.assertEqual(self.request("POST", "/api/projects", payload)[0], 403)
        headers = {"X-Latex-Token": state["csrf_token"], "Origin": "https://evil.example"}
        self.assertEqual(self.request("POST", "/api/projects", payload, headers)[0], 403)
        headers["Origin"] = f"http://127.0.0.1:{self.port}"
        status, _, data = self.request("POST", "/api/projects?name=Paper.zip", payload, headers)
        self.assertEqual(status, 201)
        project = json.loads(data)["project"]
        status, _, source = self.request("GET", f"/api/projects/{project['id']}/source?path=main.tex")
        self.assertEqual((status, source.decode()), (200, DOCUMENT))
        self.assertEqual(self.request("GET", f"/api/projects/{project['id']}/source?path=../project.json")[0], 400)
        self.assertEqual(self.request("GET", "/static/%2e%2e/core.py")[0], 400)

    def test_ui_and_headers(self):
        status, headers, data = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"Paper Studio", data)
        self.assertIn("script-src 'self'", headers["Content-Security-Policy"])
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.request("GET", "/static/styles.css")[0], 200)
        self.assertEqual(self.request("HEAD", "/api/state")[2], b"")


if __name__ == "__main__":
    unittest.main()
