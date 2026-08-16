#!/usr/bin/env python3
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

MAX_INPUT = 1_048_576
ALLOWED_KEYS = (
    "hook_event_name", "hookEventName", "session_id", "sessionId",
    "tool_name", "toolName", "tool_use_id", "toolCallId", "toolId",
    "cwd", "transcript_path", "transcriptPath", "agent_transcript_path", "agentTranscriptPath", "agent_id", "agentId", "subagent_id",
    "subagentId", "agent_type", "agentType", "parent_session_id",
    "parentSessionId", "parent_agent_id", "parentAgentId", "tool_input", "toolInput",
)
TARGET_KEYS = ("filePath", "file_path", "notebook_path", "path", "includePattern")
SECRET_RE = re.compile(r"(?i)(gh[pousr]_[A-Za-z0-9]{16,}|sk-(?:ant-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{12,}|bearer\s+[A-Za-z0-9._-]{16,})")


def read_payload():
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        return {}
    if not raw and len(sys.argv) > 1 and sys.argv[1].lstrip().startswith("{"):
        raw = sys.argv[1].encode("utf-8", "replace")
    try:
        value = json.loads(raw.decode("utf-8")) if raw else {}
        return value if isinstance(value, dict) else {}
    except (UnicodeDecodeError, ValueError):
        return {}


def first(data, *keys):
    for key in keys:
        value = data.get(key)
        if isinstance(value, (str, int)) and str(value):
            return str(value)
    return ""


def normalize_event(value):
    return {
        "SessionStart": "session_start",
        "sessionStart": "session_start",
        "SessionEnd": "session_end",
        "sessionEnd": "session_end",
        "UserPromptSubmit": "waiting",
        "userPromptSubmitted": "waiting",
        "PreToolUse": "pre_tool_use",
        "preToolUse": "pre_tool_use",
        "PostToolUse": "post_tool_use",
        "postToolUse": "post_tool_use",
        "PostToolUseFailure": "tool_error",
        "Stop": "stop",
        "agentStop": "stop",
        "SubagentStart": "subagent_start",
        "subagentStart": "subagent_start",
        "SubagentStop": "subagent_stop",
        "subagentStop": "subagent_stop",
    }.get(value, value if value in {
        "session_start", "session_end", "waiting", "pre_tool_use",
        "post_tool_use", "tool_error", "stop", "subagent_start", "subagent_stop",
    } else "")


def safe_target(data, cwd):
    tool_input = data.get("tool_input") or data.get("toolInput")
    if not isinstance(tool_input, dict):
        return ""
    for key in TARGET_KEYS:
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            value = value.split("?", 1)[0].split("#", 1)[0]
            if SECRET_RE.search(value):
                return ""
            if value.startswith("file://"):
                value = value[7:]
            if os.path.isabs(value):
                try:
                    base = os.path.realpath(cwd) if cwd else ""
                    resolved = os.path.realpath(value)
                    value = os.path.relpath(resolved, base) if base and os.path.commonpath([base, resolved]) == base else os.path.basename(resolved)
                except (OSError, ValueError):
                    value = os.path.basename(value)
            value = value.replace("\\", "/")
            while value.startswith("../"):
                value = value[3:]
            if not value.strip("*?[]{}!, "):
                return ""
            return value[:240]
    return ""


def provider(data):
    transcript = first(data, "transcript_path", "transcriptPath", "agent_transcript_path", "agentTranscriptPath").replace("\\", "/")
    if "/.claude/" in transcript or "/projects/" in transcript:
        return "claude-code"
    copilot_fields = ("hookEventName", "sessionId", "toolName", "toolCallId", "toolId", "transcriptPath", "agentTranscriptPath")
    if "/GitHub.copilot-chat/" in transcript or os.environ.get("COPILOT_SESSION_ID") or any(key in data for key in copilot_fields):
        return "github-copilot"
    return "claude-code"


def build_payload(data):
    event = normalize_event(first(data, "hook_event_name", "hookEventName") or os.environ.get("HOOK_EVENT", ""))
    session_id = first(data, "session_id", "sessionId") or os.environ.get("COPILOT_SESSION_ID", "")
    if not event or not session_id:
        return None
    agent_id = first(data, "agent_id", "agentId", "subagent_id", "subagentId")
    agent_type = first(data, "agent_type", "agentType")
    if event.startswith("subagent_") and not agent_type:
        agent_type = "subagent"
    cwd = first(data, "cwd")
    payload = {
        "event": event,
        "provider": provider(data),
        "session_id": session_id[:256],
        "tool_name": first(data, "tool_name", "toolName")[:256],
        "tool_id": first(data, "tool_use_id", "toolCallId", "toolId")[:256],
        "cwd": cwd[:2048],
        "transcript_path": first(data, "transcript_path", "transcriptPath", "agent_transcript_path", "agentTranscriptPath")[:4096],
        "agent_id": agent_id[:256],
        "agent_type": agent_type[:64],
        "parent_session_id": first(data, "parent_session_id", "parentSessionId")[:256],
        "parent_agent_id": first(data, "parent_agent_id", "parentAgentId")[:256],
        "target": safe_target(data, cwd),
    }
    return {key: value for key, value in payload.items() if value}


def broker_port():
    path = Path.home() / ".multi-agent-pixel-office" / "port"
    try:
        value = int(path.read_text(encoding="utf-8").strip())
        return value if 1 <= value <= 65535 else 7933
    except (OSError, ValueError):
        return 7933


def broker_token():
    path = Path.home() / ".multi-agent-pixel-office" / "token"
    try:
        token = path.read_text(encoding="utf-8").strip()
        return token if len(token) >= 32 else ""
    except OSError:
        return ""


def send(payload):
    token = broker_token()
    if not token:
        return
    body = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{broker_port()}/hook",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
            "X-Multi-Agent-Pixel-Office-Token": token,
        },
        method="POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=1.5) as response:
            response.read(256)
    except (OSError, urllib.error.URLError):
        pass


def main():
    data = read_payload()
    payload = build_payload({key: data.get(key) for key in ALLOWED_KEYS if key in data})
    if payload:
        send(payload)
    print('{"permissionDecision":"allow"}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
