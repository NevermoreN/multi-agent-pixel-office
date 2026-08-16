#!/usr/bin/env python3
import argparse
import json
import os
import shlex
import shutil
import secrets
import stat
import sys
import tempfile
from pathlib import Path

EVENTS = (
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "SubagentStart",
    "SubagentStop",
)


INSTALL_DIR = ".multi-agent-pixel-office"


def is_our_command(value):
    if not isinstance(value, str):
        return False
    normalized = value.replace("\\", "/")
    return "/%s/hook.py" % INSTALL_DIR in normalized


def load_object(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except ValueError as err:
        raise ValueError("invalid JSON in %s: %s" % (path, err)) from err
    if not isinstance(value, dict):
        raise ValueError("expected JSON object in %s" % path)
    return value


def backup_once(path):
    if not path.exists():
        return
    backup = path.with_name(path.name + ".multi-agent-pixel-office.backup")
    if not backup.exists():
        shutil.copy2(path, backup)
        os.chmod(backup, 0o600)


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        mode = (stat.S_IMODE(path.stat().st_mode) & 0o644) | 0o600
    except FileNotFoundError:
        mode = 0o600
    backup_once(path)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=".%s." % path.name, suffix=".tmp", delete=False) as handle:
        handle.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        temp = Path(handle.name)
    os.chmod(temp, mode)
    os.replace(temp, path)
    os.chmod(path, mode)


def install_file(source, destination, mode):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("wb", dir=destination.parent, prefix=".%s." % destination.name, suffix=".tmp", delete=False) as handle:
        temp = Path(handle.name)
        with source.open("rb") as source_handle:
            shutil.copyfileobj(source_handle, handle)
    os.chmod(temp, mode)
    os.replace(temp, destination)
    os.chmod(destination, mode)


def merge_copilot(path, command):
    root = load_object(path)
    hooks = root.get("hooks")
    if not isinstance(hooks, dict):
        hooks = {}
    for event in EVENTS:
        current = hooks.get(event)
        entries = current if isinstance(current, list) else []
        kept = [entry for entry in entries if not (isinstance(entry, dict) and is_our_command(entry.get("command")))]
        kept.append({"command": command})
        hooks[event] = kept
    root["hooks"] = hooks
    atomic_json(path, root)


def claude_entry_is_ours(entry):
    if not isinstance(entry, dict):
        return False
    hooks = entry.get("hooks")
    if not isinstance(hooks, list):
        return False
    return any(isinstance(hook, dict) and is_our_command(hook.get("command")) for hook in hooks)


def merge_claude(path, command):
    root = load_object(path)
    hooks = root.get("hooks")
    if not isinstance(hooks, dict):
        hooks = {}
    for event in EVENTS:
        current = hooks.get(event)
        entries = current if isinstance(current, list) else []
        kept = [entry for entry in entries if not claude_entry_is_ours(entry)]
        kept.append({"matcher": "", "hooks": [{"type": "command", "command": command}]})
        hooks[event] = kept
    root["hooks"] = hooks
    atomic_json(path, root)


def command_for(hook):
    parts = [sys.executable, str(hook)]
    return subprocess_list2cmdline(parts) if os.name == "nt" else shlex.join(parts)


def subprocess_list2cmdline(parts):
    import subprocess
    return subprocess.list2cmdline(parts)


def install(home, source, port):
    home = home.resolve()
    source = source.resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    install_dir = home / INSTALL_DIR
    hook = install_dir / "hook.py"
    install_file(source, hook, 0o755)
    port_file = install_dir / "port"
    port_file.write_text("%d\n" % port, encoding="utf-8")
    os.chmod(port_file, 0o644)
    token_file = install_dir / "token"
    token = ""
    try:
        token = token_file.read_text(encoding="utf-8").strip()
    except OSError:
        pass
    if len(token) < 32:
        token_file.write_text(secrets.token_urlsafe(32) + "\n", encoding="utf-8")
    os.chmod(token_file, 0o600)
    copilot = home / ".copilot" / "hooks" / "hooks.json"
    claude = home / ".claude" / "settings.json"
    command = command_for(hook)
    merge_copilot(copilot, command)
    merge_claude(claude, command)
    return {
        "hook": str(hook),
        "copilot": str(copilot),
        "claude": str(claude),
        "token": str(token_file),
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", default=str(Path.home()))
    parser.add_argument("--source", required=True)
    parser.add_argument("--port", type=int, default=7933)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    result = install(Path(args.home), Path(args.source), args.port)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
