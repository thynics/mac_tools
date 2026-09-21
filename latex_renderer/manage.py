#!/usr/bin/env python3
"""Install and manage the per-user Paper Studio macOS service."""

from __future__ import annotations

import argparse
import http.client
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote, urlencode
import uuid
import zipfile


LABEL = "com.longcheng.paper-studio"
SUPPORT = Path.home() / "Library/Application Support/Paper Studio"
APP = SUPPORT / "app"
CONFIG = SUPPORT / "config.json"
PLIST = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
LAUNCHER = Path.home() / ".local/bin/paper-studio"
LAUNCHER_MARKER = "# Paper Studio CLI; managed by manage.py"
INSTALL_MARKER = ".paper-studio-install"
DOMAIN = "gui/" + str(os.getuid())
SERVICE = DOMAIN + "/" + LABEL


class CommandError(Exception):
    pass


def absolute(value):
    return str(Path(value).expanduser().resolve())


def defaults():
    return {"port": 8787, "data_dir": str(SUPPORT / "data"),
            "tex_bin": "", "python": sys.executable}


def read_config(required=True):
    if not CONFIG.exists():
        if required:
            raise CommandError("尚未安装，请在源码目录运行 ./install.sh。")
        return defaults()
    try:
        config = json.loads(CONFIG.read_text())
        if not isinstance(config, dict):
            raise ValueError("配置必须是 JSON 对象")
        result = defaults()
        result.update(config)
        if type(result["port"]) is not int or not 1024 <= result["port"] <= 65535:
            raise ValueError("port 必须在 1024–65535 之间")
        for key in ("data_dir", "python"):
            if not isinstance(result[key], str) or not Path(result[key]).is_absolute():
                raise ValueError(key + " 必须是绝对路径")
        if not isinstance(result["tex_bin"], str):
            raise ValueError("tex_bin 必须是字符串")
        if result["tex_bin"] and not Path(result["tex_bin"]).is_absolute():
            raise ValueError("tex_bin 必须是绝对路径")
        return result
    except (OSError, ValueError, TypeError) as exc:
        raise CommandError(f"无法读取配置 {CONFIG}：{exc}") from exc


def url(config):
    return f"http://127.0.0.1:{config['port']}"


def tex_directory(preferred=""):
    candidates = [Path(preferred)] if preferred else []
    candidates += [Path.home() / ".local/share/latex-renderer/texlive/bin/universal-darwin",
                   Path("/Library/TeX/texbin")]
    available = shutil.which("latexmk")
    if available:
        candidates.append(Path(available).parent)
    candidates += sorted((Path.home() / ".local/share/latex-renderer/texlive/bin").glob("*"))
    candidates += sorted(Path("/usr/local/texlive").glob("*/bin/*darwin*"), reverse=True)
    for directory in candidates:
        if (directory / "latexmk").is_file() and os.access(directory / "latexmk", os.X_OK):
            # Preserve the bin directory: resolving latexmk itself follows its script symlink.
            return absolute(directory)
    return ""


def api(config, path="/api/state", method="GET", body=None, token=None, upload=None):
    connection = http.client.HTTPConnection("127.0.0.1", config["port"],
                                            timeout=180 if upload else 2)
    try:
        headers = {}
        if token:
            headers["X-Latex-Token"] = token
        if upload:
            headers.update({"Content-Type": "application/zip",
                            "Content-Length": str(upload.stat().st_size)})
            with upload.open("rb") as source:
                connection.request(method, path, body=source, headers=headers)
        else:
            payload = json.dumps(body).encode() if body is not None else None
            if payload is not None:
                headers["Content-Type"] = "application/json"
            connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        raw = response.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            raise CommandError("服务响应过大。")
        try:
            result = json.loads(raw)
        except (ValueError, UnicodeError) as exc:
            raise CommandError(f"HTTP {response.status}：端口未返回 Paper Studio JSON API。") from exc
        if response.status >= 400:
            detail = result.get("error", result.get("message", result)) if isinstance(result, dict) else result
            raise CommandError(f"HTTP {response.status}：{detail}")
        if not isinstance(result, dict):
            raise CommandError("服务返回了无效的 JSON 对象。")
        return result
    except (OSError, http.client.HTTPException) as exc:
        raise CommandError(f"无法访问 {url(config)}：{exc}") from exc
    finally:
        connection.close()


def probe(config):
    try:
        state = api(config)
        if state.get("app") != "paper-studio":
            return None, "该端口的 API 不是 Paper Studio"
        if not isinstance(state.get("data_dir"), str):
            return None, "Paper Studio API 缺少 data_dir，无法确认实例身份"
        if absolute(state["data_dir"]) != absolute(config["data_dir"]):
            return None, "该端口的 Paper Studio 使用另一个数据目录：" + state["data_dir"]
        return state, ""
    except CommandError as exc:
        return None, str(exc)


def listening(config):
    try:
        with socket.create_connection(("127.0.0.1", config["port"]), timeout=0.3):
            return True
    except OSError:
        return False


def launchctl(*arguments, optional=False):
    result = subprocess.run(["/bin/launchctl", *arguments], text=True,
                            capture_output=True, timeout=15)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        if optional and ("Could not find service" in detail or "Could not find domain" in detail):
            return None
        raise CommandError(f"launchctl {' '.join(arguments)} 失败（{result.returncode}）：\n{detail}")
    return result.stdout


def loaded():
    result = launchctl("print", SERVICE, optional=True)
    if result is not None and str(APP / "server.py") not in result:
        raise CommandError(f"LaunchAgent {LABEL} 已被其他程序使用；未做修改。")
    return result is not None


def verify_targets():
    if APP.is_symlink() or (APP.exists() and not (APP / INSTALL_MARKER).is_file()):
        raise CommandError(f"安装目录已存在且不是本工具管理的目录：{APP}")
    if LAUNCHER.exists() or LAUNCHER.is_symlink():
        own = False
        if LAUNCHER.is_file() and not LAUNCHER.is_symlink():
            with LAUNCHER.open("rb") as source:
                own = LAUNCHER_MARKER.encode() in source.read(4096)
        if not own:
            raise CommandError(f"命令路径已被其他文件占用；未覆盖：{LAUNCHER}")
    if PLIST.exists() or PLIST.is_symlink():
        try:
            with PLIST.open("rb") as source:
                existing = plistlib.load(source)
            own = existing.get("Label") == LABEL and str(APP / "server.py") in existing.get("ProgramArguments", [])
        except (OSError, ValueError, plistlib.InvalidFileException, AttributeError):
            own = False
        if not own or PLIST.is_symlink():
            raise CommandError(f"LaunchAgent 配置已被其他文件占用；未覆盖：{PLIST}")


def atomic_write(path, content, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name, dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(content.encode() if isinstance(content, str) else content)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def plist_content(config):
    arguments = [config["python"], str(APP / "server.py"), "--host", "127.0.0.1",
                 "--port", str(config["port"]), "--data-dir", config["data_dir"]]
    if config["tex_bin"]:
        arguments += ["--tex-bin", config["tex_bin"]]
    return plistlib.dumps({"Label": LABEL, "ProgramArguments": arguments,
                          "WorkingDirectory": str(APP), "RunAtLoad": True,
                          "KeepAlive": True, "ThrottleInterval": 5,
                          "EnvironmentVariables": {"PYTHONUNBUFFERED": "1"}, "Umask": 0o077,
                          "StandardOutPath": str(SUPPORT / "logs/server.log"),
                          "StandardErrorPath": str(SUPPORT / "logs/error.log")})


def port_conflict(config, reason):
    return CommandError(f"端口 {config['port']} 已被占用：{reason}。\n"
                        f"可用 lsof -nP -iTCP:{config['port']} -sTCP:LISTEN 检查；"
                        "或运行 install --port 其他端口。")


def wait_healthy(config):
    deadline = time.monotonic() + 12
    reason = "尚未响应"
    while time.monotonic() < deadline:
        state, reason = probe(config)
        if state is not None:
            return state
        time.sleep(0.2)
    error_log = SUPPORT / "logs/error.log"
    tail = ""
    if error_log.is_file():
        with error_log.open("rb") as source:
            source.seek(max(0, error_log.stat().st_size - 4096))
            tail = "\n" + "\n".join(source.read().decode(errors="replace").splitlines()[-12:])
    raise CommandError(f"后台服务未通过健康检查：{reason}\n错误日志：{error_log}{tail}")


def start(config):
    verify_targets()
    if not PLIST.is_file() or not (APP / "server.py").is_file():
        raise CommandError("安装不完整，请重新运行 ./install.sh。")
    is_loaded = loaded()
    state, reason = probe(config)
    if state is not None:
        if not is_loaded:
            raise port_conflict(config, "检测到未由本 LaunchAgent 管理的 Paper Studio 实例")
        return state
    if listening(config):
        raise port_conflict(config, reason)
    launchctl("enable", SERVICE)
    if is_loaded:
        launchctl("kickstart", "-k", SERVICE)
    else:
        launchctl("bootstrap", DOMAIN, str(PLIST))
    return wait_healthy(config)


def stop(config=None):
    if loaded():
        launchctl("bootout", SERVICE)
        deadline = time.monotonic() + 10
        while True:
            # bootout returns before launchd has necessarily removed the label.
            # A closed socket alone is insufficient: kickstart/bootstrap can
            # still fail with "Operation now in progress" during removal.
            still_loaded = loaded()
            port_busy = config is not None and listening(config)
            if not still_loaded and not port_busy:
                return True
            if time.monotonic() >= deadline:
                pending = []
                if still_loaded:
                    pending.append(f"LaunchAgent 标签 {SERVICE} 尚未卸载")
                if port_busy:
                    pending.append(f"端口 {config['port']} 仍被占用")
                raise CommandError("等待停止超时（10 秒）：" + "；".join(pending) + "。请运行 status 查看。")
            time.sleep(0.1)
    return False


def show_running(config, state):
    print("Paper Studio 运行中：" + url(config))
    runtime = state.get("runtime", {})
    if not runtime.get("ready"):
        print("TeX 编译工具尚未就绪；运行 paper-studio doctor 查看详情。")


def open_browser(config, project=None):
    address = url(config) + ("/?" + urlencode({"project": project}) if project else "/")
    result = subprocess.run(["/usr/bin/open", address], capture_output=True, text=True)
    if result.returncode:
        print(f"浏览器未能打开，请手动访问 {address}：{result.stderr.strip()}", file=sys.stderr)


def install(args):
    config = read_config(required=False)
    previous = dict(config)
    if args.port is not None:
        if not 1024 <= args.port <= 65535:
            raise CommandError("端口必须在 1024–65535 之间。")
        config["port"] = args.port
    if args.data_dir:
        config["data_dir"] = absolute(args.data_dir)
    if Path(config["data_dir"]).resolve().is_relative_to(APP.resolve()):
        raise CommandError("数据目录不能放在应用代码目录 app 内，升级会替换该目录。")
    if args.tex_bin:
        explicit = Path(args.tex_bin).expanduser()
        if not (explicit / "latexmk").is_file() or not os.access(explicit / "latexmk", os.X_OK):
            raise CommandError(f"--tex-bin 目录中没有可执行的 latexmk：{explicit}")
        config["tex_bin"] = absolute(explicit)
    else:
        config["tex_bin"] = tex_directory(config["tex_bin"])
    config["python"] = sys.executable
    source = Path(__file__).resolve().parent
    for name in ("server.py", "core.py", "manage.py", "static"):
        if not (source / name).exists():
            raise CommandError(f"安装源文件缺失：{source / name}")
    verify_targets()
    is_loaded = loaded()
    if listening(config):
        state, reason = probe(previous)
        if not is_loaded or config["port"] != previous["port"] or state is None:
            raise port_conflict(config, reason or "已有其他实例监听此端口")
    SUPPORT.mkdir(parents=True, exist_ok=True, mode=0o700)
    (SUPPORT / "logs").mkdir(exist_ok=True, mode=0o700)
    Path(config["data_dir"]).mkdir(parents=True, exist_ok=True, mode=0o700)
    staging = Path(tempfile.mkdtemp(prefix=".app-new-", dir=SUPPORT))
    backup = None
    try:
        for name in ("server.py", "core.py", "manage.py"):
            shutil.copy2(source / name, staging / name)
        shutil.copytree(source / "static", staging / "static",
                        ignore=shutil.ignore_patterns("__pycache__", ".DS_Store"))
        (staging / INSTALL_MARKER).write_text("Paper Studio\n")
        if is_loaded:
            stop(previous)
        if APP.exists():
            backup = SUPPORT / (".app-old-" + uuid.uuid4().hex)
            APP.rename(backup)
        try:
            staging.rename(APP)
        except OSError:
            if backup is not None:
                backup.rename(APP)
                backup = None
            raise
        atomic_write(CONFIG, json.dumps(config, ensure_ascii=False, indent=2) + "\n")
        atomic_write(PLIST, plist_content(config))
        wrapper = f"#!/bin/sh\n{LAUNCHER_MARKER}\nexec {shlex.quote(config['python'])} {shlex.quote(str(APP / 'manage.py'))} \"$@\"\n"
        atomic_write(LAUNCHER, wrapper, mode=0o755)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
        if backup is not None and backup.exists():
            shutil.rmtree(backup)
    state = start(config)
    show_running(config, state)
    print("CLI：" + str(LAUNCHER))
    print("源文件与编译数据：" + config["data_dir"])
    if not args.no_open:
        open_browser(config)
    return 0


def import_zip(config, args):
    archive = Path(args.zip).expanduser().resolve()
    if not archive.is_file() or not zipfile.is_zipfile(archive):
        raise CommandError(f"不是有效的 ZIP 文件：{archive}")
    state = start(config)
    token = state.get("csrf_token")
    if not isinstance(token, str) or not token:
        raise CommandError("服务没有返回上传所需的 CSRF token。")
    query = urlencode({"name": args.name or archive.name})
    result = api(config, "/api/projects?" + query, "POST", token=token, upload=archive)
    project = result.get("project", {})
    identifier = project.get("id")
    if not isinstance(identifier, str) or not identifier:
        raise CommandError("项目已上传，但服务没有返回有效项目 ID；请打开 UI 检查。")
    address = url(config) + "/?" + urlencode({"project": identifier})
    print(f"已导入：{project.get('name', archive.name)}（{identifier}）\n{address}")
    try:
        api(config, "/api/projects/" + quote(identifier, safe="") + "/compile",
            "POST", body={}, token=token)
    except CommandError as exc:
        raise CommandError(f"导入已完成，编译未能启动：{exc}\n请在上述地址查看项目，无需重新导入。") from exc
    print("编译已启动，可在页面查看结果与日志。")
    return 0


def doctor(config):
    ok = True
    print("配置：" + str(CONFIG))
    print("Python：" + config["python"])
    if not os.access(config["python"], os.X_OK):
        print("  不可执行，请用可用的 Python 重新安装。")
        ok = False
    directory = config["tex_bin"] or tex_directory()
    print("TeX bin：" + (directory or "未找到"))
    for command in ("latexmk", "pdflatex", "bibtex"):
        present = bool(directory) and os.access(Path(directory) / command, os.X_OK)
        print(f"  {command}: {'OK' if present else '缺失'}")
        ok = ok and present
    print("数据目录：" + config["data_dir"])
    if not Path(config["data_dir"]).is_dir() or not os.access(config["data_dir"], os.W_OK):
        print("  数据目录不存在或不可写。")
        ok = False
    managed = loaded()
    print("LaunchAgent：" + ("已加载" if managed else "未加载"))
    state, reason = probe(config)
    if state is None:
        print("HTTP 检查失败：" + reason)
        ok = False
    else:
        print("HTTP 身份与数据目录检查：OK，" + url(config))
        if not state.get("runtime", {}).get("ready"):
            print("编译运行时未就绪：" + json.dumps(state.get("runtime", {}), ensure_ascii=False))
            ok = False
    print("日志：" + str(SUPPORT / "logs"))
    return 0 if ok and managed else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description="Paper Studio：本地 LaTeX 渲染服务与后台进程管理")
    commands = parser.add_subparsers(dest="command", required=True)
    setup = commands.add_parser("install", help="安装/更新当前源码，并启动登录后台服务")
    setup.add_argument("--port", type=int, help="监听端口，首次安装默认 8787")
    setup.add_argument("--data-dir", help="项目存储目录，升级时默认保留")
    setup.add_argument("--tex-bin", help="包含 latexmk 和 TeX 引擎的 bin 目录")
    setup.add_argument("--no-open", action="store_true", help="启动后不打开浏览器")
    for name, help_text in (("start", "启动并检查后台服务"), ("stop", "停止当前会话的后台服务"),
                            ("restart", "重新加载 LaunchAgent 并启动"), ("status", "检查 API 与后台服务"),
                            ("open", "启动服务并打开网页"), ("doctor", "检查配置、TeX、服务与日志位置")):
        commands.add_parser(name, help=help_text)
    upload = commands.add_parser("import", help="导入 ZIP 并启动一次编译")
    upload.add_argument("zip", help="Overleaf/LaTeX 项目 ZIP 文件")
    upload.add_argument("--name", help="项目显示名称")
    args = parser.parse_args(argv)
    try:
        if sys.platform != "darwin":
            raise CommandError("安装与后台服务管理需要 macOS；其他平台可直接运行 server.py。")
        if args.command == "install":
            return install(args)
        config = read_config(required=args.command != "doctor")
        if args.command == "doctor":
            return doctor(config)
        if args.command == "import":
            return import_zip(config, args)
        if args.command == "stop":
            print("后台服务已停止；下次登录仍会自动启动。" if stop(config) else "后台服务未运行。")
            return 0
        if args.command == "status":
            managed = loaded()
            state, reason = probe(config)
            if state is None:
                print("后台服务未就绪：" + reason)
                print("日志：" + str(SUPPORT / "logs"))
                return 1
            show_running(config, state)
            if not managed:
                print("此实例未由本 CLI 的 LaunchAgent 管理。")
            return 0 if managed else 1
        if args.command == "restart":
            stop(config)
        state = start(config)
        show_running(config, state)
        if args.command == "open":
            open_browser(config)
        return 0
    except (CommandError, OSError, subprocess.TimeoutExpired) as exc:
        print("错误：" + str(exc), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
