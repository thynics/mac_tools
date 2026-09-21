"""Local project storage and the TeX Live / latexmk compilation worker."""

from __future__ import annotations

import copy
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import queue
import re
import shutil
import signal
import stat
import subprocess
import tempfile
import threading
import time
import uuid
import zipfile


DEFAULT_DATA = Path.home() / "Library/Application Support/Paper Studio/data"
MAX_UPLOAD = 100 * 1024 * 1024
MAX_EXPANDED = 300 * 1024 * 1024
MAX_FILES = 5000
MAX_SOURCE_TEXT = 2 * 1024 * 1024
MAX_LOG = 4 * 1024 * 1024
ENGINES = {"pdflatex": "pdfLaTeX", "xelatex": "XeLaTeX", "lualatex": "LuaLaTeX"}
TEXT_EXTENSIONS = {".tex", ".bib", ".sty", ".cls", ".bst", ".bbx", ".cbx", ".dbx", ".md", ".txt", ".json", ".cfg", ".def", ".ltx"}
IGNORED = {".git", ".svn", "__MACOSX", ".DS_Store", "__pycache__"}


def ignored(name: str) -> bool:
    return (name in IGNORED or name.startswith(".#") or name.endswith(("~", ".swp", ".swo"))
            or (name.startswith("#") and name.endswith("#")))


class UserError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def contained(root: Path, relative: str) -> Path:
    """Resolve a relative file name without allowing traversal or symlinks."""
    if not relative or "\\" in relative or "\x00" in relative:
        raise UserError("文件路径无效。")
    parts = PurePosixPath(relative)
    if parts.is_absolute() or any(p in {"..", "."} for p in parts.parts):
        raise UserError("文件路径必须在项目目录内。")
    current = root
    for part in parts.parts:
        current = current / part
        if current.is_symlink():
            raise UserError("项目不支持符号链接。")
    try:
        current.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise UserError("文件路径必须在项目目录内。") from exc
    return current


def source_files(root: Path) -> list[Path]:
    result = []
    total = 0
    for folder, directories, names in os.walk(root, followlinks=False):
        directories[:] = sorted(d for d in directories if not ignored(d))
        for name in directories + names:
            if ignored(name):
                continue
            path = Path(folder) / name
            if path.is_symlink():
                raise UserError("项目不支持符号链接：" + str(path.relative_to(root)))
        for name in sorted(names):
            if ignored(name):
                continue
            path = Path(folder) / name
            if not path.is_file():
                raise UserError("项目中存在不支持的特殊文件。")
            total += path.stat().st_size
            result.append(path)
            if len(result) > MAX_FILES or total > MAX_EXPANDED:
                raise UserError("项目过大：最多 5000 个文件、解压后 300 MB。")
    return sorted(result)


def signature(root: Path, main_file: str, engine: str) -> str:
    digest = hashlib.sha256((main_file + "\0" + engine).encode())
    for path in source_files(root):
        info = path.stat()
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(f"\0{info.st_size}:{info.st_mtime_ns}:{info.st_ctime_ns}\0".encode())
    return digest.hexdigest()


def extract_zip(payload: bytes, destination: Path) -> None:
    """Extract a bounded ZIP, rejecting traversal, links, and ambiguous names."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except (zipfile.BadZipFile, OSError) as exc:
        raise UserError("这不是有效的 ZIP 文件。请导入 Overleaf 下载的源码 ZIP。") from exc
    with archive:
        members = archive.infolist()
        if len(members) > MAX_FILES:
            raise UserError("ZIP 中的文件数量超过 5000。")
        total = 0
        seen = set()
        for item in members:
            name = item.filename
            path = PurePosixPath(name)
            if (
                not name or "\\" in name or "\x00" in name
                or path.is_absolute() or ".." in path.parts
                or any(ord(c) < 32 for c in name)
                or (path.parts and ":" in path.parts[0])
            ):
                raise UserError("ZIP 包含不安全的路径。")
            if any(part in IGNORED for part in path.parts):
                continue
            mode = item.external_attr >> 16
            if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in {0, stat.S_IFREG, stat.S_IFDIR}):
                raise UserError("ZIP 不支持符号链接或特殊文件。")
            normalized = str(path).casefold()
            if normalized in seen:
                raise UserError("ZIP 包含重复或仅大小写不同的文件名。")
            seen.add(normalized)
            if item.flag_bits & 1:
                raise UserError("不支持加密 ZIP。")
            total += item.file_size
            if total > MAX_EXPANDED:
                raise UserError("ZIP 解压后的大小超过 300 MB。")
            output = contained(destination, str(path))
            if item.is_dir():
                output.mkdir(parents=True, exist_ok=True)
                continue
            output.parent.mkdir(parents=True, exist_ok=True)
            try:
                with archive.open(item) as incoming, output.open("xb") as outgoing:
                    written = 0
                    while chunk := incoming.read(1024 * 1024):
                        written += len(chunk)
                        if written > item.file_size or written > MAX_EXPANDED:
                            raise UserError("ZIP 文件大小与目录信息不一致。")
                        outgoing.write(chunk)
            except (zipfile.BadZipFile, RuntimeError, NotImplementedError, OSError) as exc:
                raise UserError("无法解压 ZIP：" + str(exc)) from exc


def choose_main(root: Path, files: list[str]) -> str:
    if not files:
        raise UserError("ZIP 中没有找到 .tex 文件。")
    documents = []
    for name in files:
        path = contained(root, name)
        if path.stat().st_size <= MAX_SOURCE_TEXT:
            text = path.read_text(encoding="utf-8", errors="replace")
            active = re.sub(r"(?m)(?<!\\)%.*$", "", text)
            if re.search(r"\\documentclass\s*(?:\[[^\]]*\])?\s*\{", active):
                documents.append(name)
    for readme in ("README.md", "README.txt", "readme.md"):
        path = root / readme
        if path.is_file() and path.stat().st_size < MAX_SOURCE_TEXT:
            text = path.read_text(encoding="utf-8", errors="replace")
            for match in re.finditer(r"(?:root document|main (?:document|file)|主文件)[^\n]{0,100}?`([^`]+\.tex)`", text, re.I):
                if match.group(1) in documents:
                    return match.group(1)
    candidates = documents or files
    for favorite in ("main.tex", "sigconf.tex", "paper.tex", "manuscript.tex"):
        if favorite in candidates:
            return favorite
    return min(candidates, key=lambda p: (p.count("/"), len(p), p))


class TexRuntime:
    def __init__(self, tex_bin: str | None = None):
        candidates = []
        if tex_bin:
            candidates.append(Path(tex_bin).expanduser())
        if os.environ.get("LATEX_RENDERER_TEXBIN"):
            candidates.append(Path(os.environ["LATEX_RENDERER_TEXBIN"]).expanduser())
        for base in (Path.home() / ".local/share/latex-renderer/texlive/bin", Path.home() / "Library/TinyTeX/bin", Path.home() / ".TinyTeX/bin"):
            if base.is_dir():
                candidates.extend(sorted(base.iterdir()))
        candidates.extend([Path("/Library/TeX/texbin"), Path("/opt/homebrew/bin"), Path("/usr/local/bin")])
        self.path = os.pathsep.join(str(p) for p in candidates if p.is_dir()) + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin")
        self.latexmk = shutil.which("latexmk", path=self.path)
        self.available = {key: bool(self.latexmk and shutil.which(key, path=self.path)) for key in ENGINES}
        self.distribution = "未找到 TeX Live"
        executable = shutil.which("pdflatex", path=self.path)
        if executable:
            try:
                result = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5)
                self.distribution = result.stdout.splitlines()[0] if result.stdout else "TeX Live"
            except (OSError, subprocess.SubprocessError):
                self.distribution = "TeX Live"

    def public(self) -> dict:
        return {"ready": any(self.available.values()), "distribution": self.distribution, "latexmk": self.latexmk or ""}

    def engines(self) -> list[dict]:
        return [{"id": key, "name": name, "available": self.available[key]} for key, name in ENGINES.items()]


class Store:
    def __init__(self, data_dir: Path, runtime: TexRuntime, timeout: float = 180, start_workers: bool = True):
        self.data_dir = data_dir.expanduser().resolve()
        self.projects_dir = self.data_dir / "projects"
        self.projects_dir.mkdir(parents=True, exist_ok=True)
        self.runtime = runtime
        self.timeout = timeout
        self.lock = threading.RLock()
        self.projects = {}
        self.jobs = queue.Queue()
        self.stop_event = threading.Event()
        self.process = None
        self.threads = []
        for metadata in sorted(self.projects_dir.glob("*/project.json")):
            try:
                project = json.loads(metadata.read_text())
                if project["id"] != metadata.parent.name or not re.fullmatch(r"[a-f0-9]{12}", project["id"]):
                    continue
                self.projects[project["id"]] = project
                if project["build"]["status"] in {"running", "queued"}:
                    project["build"].update(status="error", error="服务已重启，请重新编译。", finished_at=time.time())
                    self._save(project)
            except (OSError, ValueError, KeyError, TypeError):
                continue
        if start_workers:
            for target in (self._worker, self._watcher):
                thread = threading.Thread(target=target, daemon=True)
                thread.start()
                self.threads.append(thread)

    def project_dir(self, project_id: str) -> Path:
        if not re.fullmatch(r"[a-f0-9]{12}", project_id) or project_id not in self.projects:
            raise UserError("项目不存在。", 404)
        return self.projects_dir / project_id

    def _get(self, project_id: str) -> dict:
        self.project_dir(project_id)
        return self.projects[project_id]

    def _save(self, project: dict) -> None:
        path = self.projects_dir / project["id"] / "project.json"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(path)

    def import_zip(self, payload: bytes, name: str) -> dict:
        if not payload or len(payload) > MAX_UPLOAD:
            raise UserError("请导入不超过 100 MB 的源码 ZIP。", 413)
        display_name = Path(name.replace("\\", "/")).name
        display_name = re.sub(r"[\x00-\x1f\x7f]", "", display_name).strip()
        display_name = re.sub(r"(?i)\.zip$", "", display_name)[:180] or "Untitled paper"
        project_id = uuid.uuid4().hex[:12]
        destination = self.projects_dir / project_id
        with tempfile.TemporaryDirectory(prefix=".import-", dir=self.data_dir) as temporary:
            staging = Path(temporary) / "source"
            staging.mkdir()
            extract_zip(payload, staging)
            # Many ZIP exporters wrap the actual project in one outer directory.
            while True:
                children = list(staging.iterdir())
                if len(children) != 1 or not children[0].is_dir():
                    break
                staging = children[0]
            files = [p.relative_to(staging).as_posix() for p in source_files(staging)]
            tex_files = [p for p in files if p.lower().endswith(".tex")]
            main_file = choose_main(staging, tex_files)
            project = {
                "id": project_id, "name": display_name, "main_file": main_file,
                "engine": "pdflatex", "watch": False, "created_at": time.time(),
                "build": {"status": "idle", "started_at": None, "finished_at": None,
                          "duration": None, "warnings": [], "error": None,
                          "pdf_built_at": None, "fingerprint": None},
            }
            with self.lock:
                destination.mkdir()
                try:
                    shutil.move(str(staging), str(destination / "source"))
                    self.projects[project_id] = project
                    self._save(project)
                except Exception:
                    self.projects.pop(project_id, None)
                    shutil.rmtree(destination, ignore_errors=True)
                    raise
        return self.describe(project_id)

    def describe(self, project_id: str, details: bool = True) -> dict:
        with self.lock:
            result = copy.deepcopy(self._get(project_id))
            directory = self.project_dir(project_id)
            root = directory / "source"
            result["root"] = str(root)
            try:
                files = source_files(root)
                current_signature = signature(root, result["main_file"], result["engine"])
                file_info = [{"path": p.relative_to(root).as_posix(), "size": p.stat().st_size} for p in files]
                result["source_error"] = None
            except (UserError, OSError) as exc:
                # One broken or momentarily renamed source tree must not hide
                # other projects or a previously successful PDF.
                files, file_info, current_signature = [], [], None
                result["source_error"] = str(exc)
            result["tex_files"] = [p.relative_to(root).as_posix() for p in files if p.suffix.lower() == ".tex"]
            result["files"] = file_info if details else []
            build = result["build"]
            build["source_changed"] = current_signature is None or build.get("fingerprint") != current_signature
            build.pop("fingerprint", None)
            build["pdf_url"] = f"/api/projects/{project_id}/pdf" if (directory / "artifacts/document.pdf").is_file() else None
            build["log_tail"] = self.read_log(project_id)[-20000:] if details else ""
            return result

    def list_projects(self) -> list[dict]:
        with self.lock:
            ids = sorted(self.projects, key=lambda key: self.projects[key]["created_at"], reverse=True)
            return [self.describe(key, details=False) for key in ids]

    def update(self, project_id: str, changes: dict) -> dict:
        if not isinstance(changes, dict) or set(changes) - {"main_file", "engine", "watch", "name"}:
            raise UserError("项目设置无效。")
        with self.lock:
            project = self._get(project_id)
            busy = project["build"]["status"] in {"queued", "running"}
            if busy and any(key in changes and changes[key] != project[key] for key in ("main_file", "engine")):
                raise UserError("编译中，请等本次编译结束后再更改入口或引擎。", 409)
            if "main_file" in changes:
                name = changes["main_file"]
                if not isinstance(name, str) or not name.endswith(".tex"):
                    raise UserError("请选择 .tex 主文档。")
                path = contained(self.project_dir(project_id) / "source", name)
                if not path.is_file():
                    raise UserError("主文档不存在。")
            if "engine" in changes and (not isinstance(changes["engine"], str) or changes["engine"] not in ENGINES):
                raise UserError("不支持的编译引擎。")
            if "watch" in changes and not isinstance(changes["watch"], bool):
                raise UserError("自动编译选项必须为 true 或 false。")
            if "name" in changes and (not isinstance(changes["name"], str) or not changes["name"].strip() or len(changes["name"]) > 180):
                raise UserError("项目名称需要 1 到 180 个字符。")
            project.update(changes)
            self._save(project)
        return self.describe(project_id)

    def compile(self, project_id: str) -> dict:
        with self.lock:
            project = self._get(project_id)
            if project["build"]["status"] in {"queued", "running"}:
                raise UserError("该项目已在编译队列中。", 409)
            if not self.runtime.available.get(project["engine"]):
                raise UserError("没有找到 latexmk 或所选引擎。请先安装 TeX Live。", 503)
            main = project["main_file"]
            if not re.fullmatch(r"[\w ./-]+\.tex", main) or not contained(self.project_dir(project_id) / "source", main).is_file():
                raise UserError("主文件不存在，或文件名含有不支持的符号。请使用字母、数字、空格、点、下划线或短横线。")
            project["build"].update(status="queued", error=None, started_at=None, finished_at=None, duration=None, warnings=[])
            self._save(project)
            self.jobs.put(project_id)
        return self.describe(project_id)

    def read_log(self, project_id: str) -> str:
        path = self.project_dir(project_id) / "compile.log"
        try:
            with path.open("rb") as stream:
                size = path.stat().st_size
                if size > MAX_LOG:
                    stream.seek(-MAX_LOG, os.SEEK_END)
                data = stream.read(MAX_LOG)
            return ("[仅显示最后 4 MB 日志]\n" if size > MAX_LOG else "") + data.decode("utf-8", errors="replace")
        except FileNotFoundError:
            return ""

    def read_source(self, project_id: str, relative: str) -> str:
        path = contained(self.project_dir(project_id) / "source", relative)
        if not path.is_file():
            raise UserError("文件不存在。", 404)
        if path.suffix.lower() not in TEXT_EXTENSIONS and path.name not in {".gitignore", "Makefile"}:
            raise UserError("此文件不是可预览的文本源码。")
        if path.stat().st_size > MAX_SOURCE_TEXT:
            raise UserError("该源码超过 2 MB，请在本地编辑器中打开。", 413)
        return path.read_text(encoding="utf-8", errors="replace")

    def pdf_path(self, project_id: str) -> Path:
        path = self.project_dir(project_id) / "artifacts/document.pdf"
        if not path.is_file():
            raise UserError("尚未生成 PDF，请先编译。", 404)
        return path

    def _worker(self) -> None:
        while not self.stop_event.is_set():
            try:
                project_id = self.jobs.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                self._run(project_id)
            finally:
                self.jobs.task_done()

    def _run(self, project_id: str) -> None:
        start = time.time()
        directory = self.project_dir(project_id)
        error = None
        warnings = []
        fingerprint = None
        diagnostics = None
        success = False
        process = None
        with self.lock:
            project = self._get(project_id)
            main, engine = project["main_file"], project["engine"]
            project["build"].update(status="running", started_at=start)
            self._save(project)
        try:
            with (directory / "compile.log").open("wb") as log:
                with tempfile.TemporaryDirectory(prefix="compile-", dir=directory) as temporary:
                    working = Path(temporary) / "source"
                    working.mkdir()
                    source = directory / "source"
                    fingerprint = signature(source, main, engine)
                    for path in source_files(source):
                        target = working / path.relative_to(source)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(path, target)
                    output = working / "paper-studio-output"
                    if output.exists():
                        raise UserError("项目包含保留目录 paper-studio-output，请重命名该目录。")
                    output.mkdir()
                    flag = {"pdflatex": "-pdf", "xelatex": "-xelatex", "lualatex": "-lualatex"}[engine]
                    command = [self.runtime.latexmk, "-norc", flag, "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-no-shell-escape", "-outdir=paper-studio-output", "./" + main]
                    log.write(("TeX Live + latexmk · " + ENGINES[engine] + "\n" + " ".join(command) + "\n\n").encode())
                    log.flush()
                    environment = dict(os.environ)
                    environment.update(PATH=self.runtime.path, openin_any="p", openout_any="p", TEXMFOUTPUT=str(output), TEXMF_OUTPUT_DIRECTORY=str(output))
                    # Imported .latexmkrc files and shell escape are intentionally disabled.
                    with self.lock:
                        if self.stop_event.is_set():
                            raise UserError("服务正在停止，本次编译已取消。")
                        process = subprocess.Popen(command, cwd=working, env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                        self.process = process
                    try:
                        returncode = process.wait(timeout=self.timeout)
                    except subprocess.TimeoutExpired:
                        self._kill(process)
                        raise UserError(f"编译超过 {self.timeout:g} 秒，已停止。请查看日志。")
                    finally:
                        with self.lock:
                            self.process = None
                    generated = output / (Path(main).stem + ".pdf")
                    final_log = output / (Path(main).stem + ".log")
                    if final_log.is_file():
                        with final_log.open("rb") as stream:
                            if os.fstat(stream.fileno()).st_size > MAX_LOG:
                                stream.seek(-MAX_LOG, os.SEEK_END)
                            diagnostics = stream.read(MAX_LOG).decode("utf-8", errors="replace")
                    if returncode != 0:
                        raise UserError(f"编译失败（退出码 {returncode}），请展开日志查看具体位置。")
                    if not generated.is_file() or generated.stat().st_size < 20:
                        raise UserError("编译器没有生成有效 PDF，请查看日志。")
                    with generated.open("rb") as pdf:
                        if pdf.read(5) != b"%PDF-":
                            raise UserError("编译结果不是有效的 PDF。")
                    artifacts = directory / "artifacts"
                    artifacts.mkdir(exist_ok=True)
                    temporary_pdf = artifacts / "document.pdf.tmp"
                    shutil.copyfile(generated, temporary_pdf)
                    temporary_pdf.replace(artifacts / "document.pdf")
                    success = True
        except Exception as exc:
            error = str(exc) or type(exc).__name__
            with (directory / "compile.log").open("ab") as log:
                log.write(("\n[Paper Studio] " + error + "\n").encode())
        finally:
            if process is not None and process.poll() is None:
                self._kill(process)
            with self.lock:
                self.process = None
                # Only the final TeX pass describes the finished PDF: early passes
                # normally contain undefined citations that latexmk then resolves.
                text = diagnostics if diagnostics is not None else self.read_log(project_id)
                for line in text.splitlines():
                    if re.search(r"(?:LaTeX|Package .+|Class .+) Warning:|Overfull \\[hv]box|Underfull \\[hv]box", line):
                        line = line.strip()
                        if line not in warnings:
                            warnings.append(line)
                build = self._get(project_id)["build"]
                build.update(status="success" if success else "error", finished_at=time.time(), duration=round(time.time() - start, 2), error=error, warnings=warnings[:80])
                if success:
                    build.update(pdf_built_at=time.time(), fingerprint=fingerprint)
                self._save(self._get(project_id))

    @staticmethod
    def _kill(process: subprocess.Popen) -> None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=3)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=3)

    def _watcher(self) -> None:
        observed = {}
        attempted = {}
        while not self.stop_event.wait(0.8):
            with self.lock:
                projects = list(self.projects.values())
            for project in projects:
                if not project["watch"]:
                    observed.pop(project["id"], None)
                    attempted.pop(project["id"], None)
                    continue
                try:
                    project_id = project["id"]
                    current = signature(self.project_dir(project_id) / "source", project["main_file"], project["engine"])
                    previous = observed.get(project_id)
                    observed[project_id] = current
                    if current != previous or project["build"]["status"] in {"queued", "running"}:
                        continue
                    if current == project["build"].get("fingerprint") or current == attempted.get(project_id):
                        continue
                    attempted[project_id] = current
                    self.compile(project_id)
                except (UserError, OSError):
                    continue

    def close(self) -> None:
        self.stop_event.set()
        with self.lock:
            process = self.process
        if process is not None and process.poll() is None:
            self._kill(process)
        for thread in self.threads:
            thread.join(timeout=5)
