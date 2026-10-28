#!/usr/bin/env python3
"""Migrate existing local chats to the official HTTP provider via Codex RPC.

Without --apply this only reads metadata. --apply restarts the desktop app and
resumes the specified chats without sending any new prompt. No history or
SQLite records are edited by this script. Requires Python 3.11+.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import signal
import sqlite3
import subprocess
import threading
import time
import tomllib
import uuid

APP = '/Applications/ChatGPT.app'
MAIN = APP + '/Contents/MacOS/ChatGPT'
BINARY = APP + '/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'


def processes():
    result = {}
    for line in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,comm='], text=True).splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            result[int(parts[0])] = (int(parts[1]), parts[2])
    return result


def metadata(root, thread_id):
    with sqlite3.connect('file:' + str(root / 'state_5.sqlite') + '?mode=ro', uri=True) as db:
        row = db.execute('SELECT id,model_provider,archived FROM threads WHERE id=?', (thread_id,)).fetchone()
    if row is None or row[2]:
        raise RuntimeError('Missing or archived chat: ' + thread_id)
    return {'thread_id': row[0], 'provider': row[1]}


class Rpc:
    def __init__(self, logfile):
        self.log = open(logfile, 'a')
        self.process = subprocess.Popen([BINARY, 'app-server', '--stdio'], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=self.log, text=True, bufsize=1)
        self.items = queue.Queue()
        self.serial = 0
        def read():
            for line in self.process.stdout:
                try:
                    self.items.put(json.loads(line))
                except ValueError:
                    pass
            self.items.put(None)
        threading.Thread(target=read, daemon=True).start()
        try:
            self.call('initialize', {'clientInfo': {'name': 'network_diagnostics', 'version': '1.0'},
                                     'capabilities': {'experimentalApi': True}})
            self.process.stdin.write('{"method":"initialized"}\n')
            self.process.stdin.flush()
        except Exception:
            self.close()
            raise

    def call(self, method, params, timeout=90):
        self.serial += 1
        self.process.stdin.write(json.dumps({'id': self.serial, 'method': method, 'params': params}) + '\n')
        self.process.stdin.flush()
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            try:
                item = self.items.get(timeout=min(1, until - time.monotonic()))
            except queue.Empty:
                continue
            if item is None:
                raise RuntimeError('Codex RPC exited')
            if item.get('id') == self.serial:
                if 'error' in item:
                    raise RuntimeError(method + ': ' + str(item['error']))
                return item['result']
        raise TimeoutError(method)

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=10)
        self.log.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--thread', action='append', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--delay', type=int, default=0, help='Allow the caller to finish its turn before restarting')
    args = parser.parse_args()
    ids = list(dict.fromkeys(str(uuid.UUID(value)) for value in args.thread))
    root = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
    cfg = tomllib.loads((root / 'config.toml').read_text())
    provider = cfg.get('model_providers', {}).get('openai_http', {})
    expected = {'name': 'OpenAI', 'wire_api': 'responses', 'requires_openai_auth': True,
                'supports_websockets': False, 'supports_standalone_web_search': True}
    if cfg.get('model_provider') != 'openai_http' or provider != expected:
        raise RuntimeError('Install the official HTTP configuration first')
    before = [metadata(root, thread_id) for thread_id in ids]
    if any(row['provider'] not in ('openai', 'openai_http') for row in before):
        raise RuntimeError('Only official OpenAI chats can be migrated')
    print(json.dumps({'before': before, 'apply': args.apply}), flush=True)
    if not args.apply:
        return
    args.report.parent.mkdir(parents=True, exist_ok=True)
    report = {'before': before, 'after': [], 'success': False}
    rpc = None
    try:
        time.sleep(max(0, min(args.delay, 30)))
        old = processes()
        mains = [pid for pid, (_, command) in old.items() if command == MAIN]
        servers = [pid for pid, (parent, command) in old.items() if parent in mains and command == BINARY]
        for pid in mains:
            os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 25
        while any(pid in processes() for pid in mains) and time.monotonic() < deadline:
            time.sleep(0.5)
        if any(pid in processes() for pid in mains):
            raise RuntimeError('Desktop app did not exit; migration not attempted')
        for pid in servers:
            if pid in processes():
                os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 15
        while any(pid in processes() for pid in servers) and time.monotonic() < deadline:
            time.sleep(0.5)
        if any(pid in processes() for pid in servers):
            raise RuntimeError('Old app server is still running; migration not attempted')
        rpc = Rpc(args.report.with_suffix('.rpc.log'))
        for thread_id in ids:
            result = rpc.call('thread/resume', {'threadId': thread_id, 'modelProvider': 'openai_http',
                                                'excludeTurns': True}, timeout=120)
            if result.get('modelProvider') != 'openai_http':
                raise RuntimeError('Resume did not select HTTP for ' + thread_id)
            print(json.dumps({'resumed': thread_id, 'provider': result['modelProvider']}), flush=True)
            rpc.call('thread/unsubscribe', {'threadId': thread_id})
        rpc.close()
        rpc = None
        deadline = time.monotonic() + 10
        while True:
            report['after'] = [metadata(root, thread_id) for thread_id in ids]
            if all(row['provider'] == 'openai_http' for row in report['after']):
                report['success'] = True
                break
            if time.monotonic() >= deadline:
                raise RuntimeError('Native resume did not persist the provider in thread metadata')
            time.sleep(0.5)
    except Exception as exc:
        report['error'] = str(exc)
    finally:
        if rpc is not None:
            try:
                rpc.close()
            except Exception as exc:
                report['cleanup_error'] = str(exc)
        subprocess.run(['open', '-a', APP], check=False)
        report['finished_at'] = time.strftime('%Y-%m-%d %H:%M:%S %z')
        args.report.write_text(json.dumps(report, indent=2))
        print(json.dumps(report), flush=True)
    if not report['success']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
