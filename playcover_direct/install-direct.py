#!/usr/bin/env python3
"""Install or remove a game-local direct-network library without network configuration changes."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import struct
import subprocess
import time

GAME_ID = 'com.tencent.jkchess'
LOAD_PATH = b'@executable_path/Frameworks/PlayCoverDirect.dylib\0'

def run(*args):
    return subprocess.run(args, check=True, capture_output=True)

def inject(executable):
    with executable.open('rb') as f:
        header = f.read(32)
        if struct.unpack_from('<I', header)[0] != 0xfeedfacf:
            raise RuntimeError('Expected an arm64 Mach-O executable')
        ncmds, sizeofcmds = struct.unpack_from('<II', header, 16)
        commands = f.read(sizeofcmds)
        position = 0
        offsets = []
        for _ in range(ncmds):
            command, length = struct.unpack_from('<II', commands, position)
            if length < 8 or position + length > len(commands):
                raise RuntimeError('Invalid Mach-O load command')
            if command in (0xc, 0x80000018):
                name_offset = struct.unpack_from('<I', commands, position + 8)[0]
                name = commands[position + name_offset:position + length].split(b'\0', 1)[0]
                if name == LOAD_PATH.rstrip(b'\0'):
                    return False
            if command == 0x19:
                nsects = struct.unpack_from('<I', commands, position + 64)[0]
                for index in range(nsects):
                    section_offset = struct.unpack_from('<I', commands, position + 72 + index * 80 + 48)[0]
                    if section_offset:
                        offsets.append(section_offset)
            position += length
        size = (24 + len(LOAD_PATH) + 7) & ~7
        if not offsets or min(offsets) - 32 - sizeofcmds < size:
            raise RuntimeError('Insufficient Mach-O header padding; executable was not changed')
        padding = f.read(size)
        if any(padding):
            raise RuntimeError('Header padding contains data; executable was not changed')
    command = struct.pack('<IIIIII', 0xc, size, 24, 0, 0x10000, 0x10000) + LOAD_PATH
    command += bytes(size - len(command))
    with executable.open('r+b') as f:
        f.seek(16)
        f.write(struct.pack('<II', ncmds + 1, sizeofcmds + size))
        f.seek(32 + sizeofcmds)
        f.write(command)
    return True

def stop_game(executable):
    for line in run('ps', '-A', '-o', 'pid=', '-o', 'comm=').stdout.decode().splitlines():
        pieces = line.strip().split(None, 1)
        if len(pieces) == 2 and pieces[1] == str(executable):
            os.kill(int(pieces[0]), signal.SIGTERM)
    for _ in range(20):
        listing = run('ps', '-A', '-o', 'comm=').stdout.decode().splitlines()
        if str(executable) not in [line.strip() for line in listing]:
            return
        time.sleep(0.1)
    raise RuntimeError('Game did not exit; no application files were modified')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--remove', action='store_true')
    args = parser.parse_args()
    app = Path.home() / 'Library/Containers/io.playcover.PlayCover/Applications' / (GAME_ID + '.app')
    with (app / 'Info.plist').open('rb') as f:
        info = plistlib.load(f)
    if info.get('CFBundleIdentifier') != GAME_ID:
        raise RuntimeError('Unexpected application identifier')
    executable = app / info['CFBundleExecutable']
    target = app / 'Frameworks/PlayCoverDirect.dylib'
    backup = Path.home() / 'Library/Application Support/PlayCoverDirect' / GAME_ID / str(info['CFBundleVersion'])
    stop_game(executable)
    if args.remove:
        if not (backup / 'original-executable').exists():
            raise RuntimeError('Original executable backup is unavailable')
        shutil.copy2(backup / 'original-executable', executable)
        target.unlink(missing_ok=True)
    else:
        source = Path(__file__).resolve().parent / 'PlayCoverDirect.dylib'
        if not source.exists():
            raise RuntimeError('Build PlayCoverDirect.dylib before installing')
        backup.mkdir(parents=True, exist_ok=True)
        if not (backup / 'original-executable').exists():
            result = run('codesign', '-d', '--entitlements', '-', '--xml', str(app))
            xml = next((data[data.index(b'<?xml'):] for data in (result.stdout, result.stderr) if b'<?xml' in data), None)
            if xml is None:
                raise RuntimeError('Could not preserve application entitlements')
            plistlib.loads(xml)
            (backup / 'entitlements.plist').write_bytes(xml)
            shutil.copy2(executable, backup / 'original-executable')
            (backup / 'metadata.json').write_text(json.dumps({'bundle': GAME_ID, 'version': info['CFBundleShortVersionString'], 'build': info['CFBundleVersion']}, indent=2))
        shutil.copy2(source, target)
        run('codesign', '--force', '--sign', '-', str(target))
        inject(executable)
    try:
        run('codesign', '--force', '--sign', '-', '--entitlements', str(backup / 'entitlements.plist'), str(app))
        run('codesign', '--verify', '--deep', '--strict', str(app))
    except Exception:
        if not args.remove:
            shutil.copy2(backup / 'original-executable', executable)
            target.unlink(missing_ok=True)
            run('codesign', '--force', '--sign', '-', '--entitlements', str(backup / 'entitlements.plist'), str(app))
        raise
    print('Direct networking removed' if args.remove else 'Game-local direct networking installed and signature verified')
    print('Original executable backup:', backup)

if __name__ == '__main__':
    main()
