#!/usr/bin/env python3
import argparse
import glob
import hashlib
import json
import os
import queue
import re
import secrets
import signal
import sys
import tempfile
import threading
import time
from collections import OrderedDict
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

try:
    import fcntl
except ImportError:
    fcntl = None

try:
    import msvcrt
except ImportError:
    msvcrt = None


def default_user_data():
    if os.name == "nt" and os.environ.get("APPDATA"):
        return str(Path(os.environ["APPDATA"]) / "Code" / "User")
    if sys.platform == "darwin":
        return str(Path.home() / "Library" / "Application Support" / "Code" / "User")
    code_server = Path.home() / ".local" / "share" / "code-server" / "User"
    if code_server.is_dir():
        return str(code_server)
    return str(Path.home() / ".config" / "Code" / "User")


RUNTIME_DIR = Path.home() / ".multi-agent-pixel-office"
USER_DATA = os.environ.get("MULTI_AGENT_PIXEL_OFFICE_USER_DATA", default_user_data())
CLAUDE_HOME = os.environ.get("MULTI_AGENT_PIXEL_OFFICE_CLAUDE_HOME", str(Path.home() / ".claude"))
STATE_FILE = os.environ.get("MULTI_AGENT_PIXEL_OFFICE_STATE", str(RUNTIME_DIR / "state.json"))
TOKEN_FILE = os.environ.get("MULTI_AGENT_PIXEL_OFFICE_TOKEN", str(RUNTIME_DIR / "token"))
POLL_INTERVAL = float(os.environ.get("MULTI_AGENT_PIXEL_OFFICE_POLL", "1"))
STALE_TTL = int(os.environ.get("MULTI_AGENT_PIXEL_OFFICE_STALE_TTL", "900"))
MAIN_STOP_TTL = int(os.environ.get("MULTI_AGENT_PIXEL_OFFICE_MAIN_STOP_TTL", "300"))
SUBAGENT_STOP_TTL = int(os.environ.get("MULTI_AGENT_PIXEL_OFFICE_SUBAGENT_STOP_TTL", "60"))
SESSION_END_TTL = int(os.environ.get("MULTI_AGENT_PIXEL_OFFICE_END_TTL", "15"))
MAX_BODY = 65536
MAX_CLIENTS = 64
MAX_AGENTS = 256
MAX_TOOLS_PER_AGENT = 32
MAX_COPILOT_PARTS_PER_SESSION = 4096
MAX_COPILOT_SESSION_CACHES = 512
MAX_FILE_TAIL = 32 * 1024 * 1024
SSE_HEARTBEAT = 20
SSE_MAX_LIFETIME = 300
RECENT_TRANSCRIPT_AGE = 24 * 3600

PROVIDERS = {"github-copilot", "claude-code"}
EVENTS = {
    "session_start", "session_end", "waiting", "pre_tool_use", "post_tool_use",
    "tool_error", "stop", "subagent_start", "subagent_stop",
}
ID_RE = re.compile(r"[^A-Za-z0-9._:@-]+")
WORKSPACE_RE = re.compile(r"[/\\]workspaceStorage[/\\]([^/\\]+)[/\\]GitHub\.copilot-chat[/\\]")
CHAT_SESSION_RE = re.compile(r"[/\\]workspaceStorage[/\\]([^/\\]+)[/\\]chatSessions[/\\]")
SECRET_RE = re.compile(r"(?i)(gh[pousr]_[A-Za-z0-9]{16,}|sk-(?:ant-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{12,}|bearer\s+[A-Za-z0-9._-]{16,})")


def now_ms():
    return int(time.time() * 1000)


def load_or_create_token(path_value):
    path = Path(path_value)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as handle:
        os.chmod(path, 0o600)
        lock_file(handle)
        handle.seek(0)
        token = handle.read().strip()
        if len(token) < 32:
            token = secrets.token_urlsafe(32)
            handle.seek(0)
            handle.truncate()
            handle.write(token + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        return token


def lock_file(handle):
    if fcntl is not None:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        return
    if msvcrt is None:
        return
    handle.seek(0, os.SEEK_END)
    if handle.tell() == 0:
        handle.write(" ")
        handle.flush()
    handle.seek(0)
    msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)


def parse_time(value):
    if isinstance(value, (int, float)):
        return int(value if value > 10_000_000_000 else value * 1000)
    if not isinstance(value, str) or not value:
        return now_ms()
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return now_ms()


def clean_text(value, limit=256):
    if not isinstance(value, (str, int)):
        return ""
    text = str(value).replace("\x00", "").replace("\r", " ").replace("\n", " ").strip()
    return text[:limit]


def clean_id(value):
    return ID_RE.sub("_", clean_text(value, 256))[:256]


def workspace_label(path_value):
    value = clean_text(path_value, 2048).rstrip("/\\")
    if not value:
        return "Unknown workspace"
    return os.path.basename(value) or value[:80]


def target_from_arguments(arguments):
    if not isinstance(arguments, dict):
        return ""
    for key in ("filePath", "file_path", "notebook_path", "path", "includePattern"):
        value = arguments.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def safe_target(value, cwd=""):
    text = clean_text(value, 1024)
    if not text:
        return ""
    if SECRET_RE.search(text):
        return ""
    text = text.split("?", 1)[0].split("#", 1)[0]
    if text.startswith("file://"):
        text = text[7:]
    if os.path.isabs(text):
        try:
            base = os.path.realpath(cwd) if cwd else ""
            resolved = os.path.realpath(text)
            if base and os.path.commonpath([base, resolved]) == base:
                text = os.path.relpath(resolved, base)
            else:
                text = os.path.basename(resolved)
        except (OSError, ValueError):
            text = os.path.basename(text)
    text = text.replace("\\", "/")
    while text.startswith("../"):
        text = text[3:]
    if not text.strip("*?[]{}!, "):
        return ""
    return text[:240]


def safe_display(value, fallback=""):
    text = clean_text(value, 256)
    if not text or SECRET_RE.search(text):
        return fallback
    return text


def tool_status(name):
    value = clean_text(name, 256).lower()
    if any(word in value for word in ("read", "view", "list", "get", "open")):
        return "reading"
    if any(word in value for word in ("write", "edit", "create", "insert", "patch", "rename")):
        return "writing"
    if any(word in value for word in ("run", "exec", "bash", "terminal", "task", "notebook")):
        return "running"
    if any(word in value for word in ("search", "grep", "find", "web", "query")):
        return "searching"
    return "other"


def activity_for_tool(name, target=""):
    status = tool_status(name)
    if clean_text(name).lower() == "runsubagent":
        return "启动子 Agent"
    if status == "reading":
        return "读取 %s" % target if target else "读取文件"
    if status == "writing":
        return "编辑 %s" % target if target else "编辑文件"
    if status == "running":
        return "运行终端工具"
    if status == "searching":
        return "搜索 %s" % target if target else "搜索代码"
    return "使用 %s" % clean_text(name, 80) if name else "执行工具"


def workspace_context(provider, transcript_path="", cwd=""):
    if provider == "github-copilot":
        match = WORKSPACE_RE.search(transcript_path or "")
        if match:
            workspace_id = match.group(1)
            label = workspace_id
            try:
                meta = json.loads(Path(USER_DATA, "workspaceStorage", workspace_id, "meta.json").read_text(encoding="utf-8"))
                label = clean_text(meta.get("name"), 100) or workspace_id
            except (OSError, ValueError):
                pass
            return "workspaceStorage:%s" % workspace_id, label
    normalized = os.path.realpath(cwd) if cwd else "unknown"
    return "cwd:%s" % normalized, workspace_label(cwd)


def agent_id(provider, namespace, session_id, child_id=""):
    ns = hashlib.sha256(namespace.encode("utf-8", "replace")).hexdigest()[:12]
    base = "%s:%s:%s" % (provider, ns, clean_id(session_id))
    return "%s:%s" % (base, clean_id(child_id)) if child_id else base


def public_agent(agent):
    tools = []
    for tool in agent["activeTools"].values():
        public_tool = {
            "id": tool["id"],
            "name": safe_display(tool.get("name"), "tool"),
            "status": tool["status"],
            "startedAt": tool["startedAt"],
        }
        target = safe_display(tool.get("target"))
        if target:
            public_tool["target"] = target
        tools.append(public_tool)
    return {
        "id": agent["id"],
        "provider": agent["provider"],
        "kind": agent["kind"],
        **({"parentId": agent["parentId"]} if agent.get("parentId") else {}),
        "sessionId": agent["sessionId"],
        "workspace": safe_display(agent["workspace"], "Unknown workspace"),
        "name": safe_display(agent["name"], "Agent"),
        "phase": agent["phase"],
        "activity": safe_display(agent["activity"], "Working"),
        **({"toolName": safe_display(agent["toolName"], "tool")} if agent.get("toolName") else {}),
        **({"target": safe_display(agent["target"])} if safe_display(agent.get("target")) else {}),
        "startedAt": agent["startedAt"],
        "updatedAt": agent["updatedAt"],
        **({"completedAt": agent["completedAt"]} if agent.get("completedAt") else {}),
        "activeTools": sorted(tools, key=lambda item: item["startedAt"]),
        **({"inputTokens": agent["inputTokens"]} if isinstance(agent.get("inputTokens"), int) else {}),
        **({"outputTokens": agent["outputTokens"]} if isinstance(agent.get("outputTokens"), int) else {}),
    }


class Broker:
    def __init__(self, state_file=STATE_FILE):
        self.state_file = state_file
        self.lock = threading.RLock()
        self.agents = {}
        self.revision = 0
        self.clients = []
        self.dedupe = OrderedDict()
        self.started = time.time()
        self.instance_id = secrets.token_hex(8)
        self.token = load_or_create_token(TOKEN_FILE)
        self.loop_at = 0.0
        self.events = 0
        self.duplicates = 0
        self.ambiguous_tools = 0
        self.files_seen = 0
        self.copilot_parts = {}
        self.persist_event = threading.Event()
        self.stopped = threading.Event()
        self._load()
        threading.Thread(target=self._persist_worker, daemon=True, name="pixel-persist").start()

    def stop(self):
        self.stopped.set()
        self.persist_event.set()

    def snapshot(self):
        with self.lock:
            agents = sorted((public_agent(agent) for agent in self.agents.values()), key=lambda item: (item["workspace"], item["kind"] != "main", item["startedAt"], item["id"]))
            return {"instanceId": self.instance_id, "revision": self.revision, "generatedAt": now_ms(), "agents": agents}

    def status(self):
        with self.lock:
            loop_age = int(time.time() - self.loop_at) if self.loop_at else -1
            return {
                "pid": os.getpid(),
                "instanceId": self.instance_id,
                "revision": self.revision,
                "agents": len(self.agents),
                "clients": len(self.clients),
                "events": self.events,
                "duplicates": self.duplicates,
                "ambiguousTools": self.ambiguous_tools,
                "filesSeen": self.files_seen,
                "loopAgeSec": loop_age,
                "uptimeSec": int(time.time() - self.started),
                "threads": threading.active_count(),
            }

    def subscribe(self):
        channel = queue.Queue(maxsize=2)
        with self.lock:
            while len(self.clients) >= MAX_CLIENTS:
                old = self.clients.pop(0)
                try:
                    old.put_nowait(None)
                except queue.Full:
                    pass
            self.clients.append(channel)
        return channel

    def unsubscribe(self, channel):
        with self.lock:
            if channel in self.clients:
                self.clients.remove(channel)

    def process_hook(self, payload):
        event = clean_text(payload.get("event"), 64)
        provider = clean_text(payload.get("provider"), 64)
        session_id = clean_id(payload.get("session_id"))
        if event not in EVENTS or provider not in PROVIDERS or not session_id:
            return False
        namespace, workspace = workspace_context(provider, clean_text(payload.get("transcript_path"), 4096), clean_text(payload.get("cwd"), 2048))
        tool_id = clean_id(payload.get("tool_id"))
        child_id = clean_id(payload.get("agent_id"))
        dedupe_key = (provider, namespace, session_id, event, child_id, tool_id)
        with self.lock:
            if self._duplicate(dedupe_key):
                self.duplicates += 1
                return False
            changed = self._process_event_locked({
                "event": event,
                "provider": provider,
                "namespace": namespace,
                "workspace": workspace,
                "session_id": session_id,
                "child_id": child_id,
                "agent_type": clean_text(payload.get("agent_type"), 80),
                "tool_id": tool_id,
                "tool_name": clean_text(payload.get("tool_name"), 128),
                "target": safe_target(payload.get("target"), clean_text(payload.get("cwd"), 2048)),
                "timestamp": now_ms(),
            })
            self.events += 1
            if changed:
                self._publish_locked()
            return changed

    def apply_copilot_records(self, path, records):
        match = WORKSPACE_RE.search(path)
        if not match:
            return
        workspace_id = match.group(1)
        namespace, workspace = workspace_context("github-copilot", path, "")
        session_id = clean_id(Path(path).stem)
        changed = False
        recent_after = now_ms() - STALE_TTL * 1000
        with self.lock:
            for record in records:
                data = record.get("data") if isinstance(record.get("data"), dict) else {}
                timestamp = parse_time(record.get("timestamp"))
                if timestamp < recent_after:
                    continue
                record_type = record.get("type")
                if record_type == "session.start":
                    session_id = clean_id(data.get("sessionId")) or session_id
                    main = self._ensure_main_locked("github-copilot", namespace, workspace, session_id, timestamp)
                    changed |= self._set_agent_locked(main, timestamp, phase="starting", activity="Copilot 会话已开始")
                elif record_type == "assistant.message":
                    for request in data.get("toolRequests") or []:
                        if not isinstance(request, dict) or request.get("name") != "runSubagent":
                            continue
                        call_id = clean_id(request.get("toolCallId"))
                        arguments = request.get("arguments")
                        if isinstance(arguments, str):
                            try:
                                arguments = json.loads(arguments)
                            except ValueError:
                                arguments = {}
                        name = clean_text(arguments.get("agentName"), 80) if isinstance(arguments, dict) else ""
                        child = self._ensure_child_locked("github-copilot", namespace, workspace, session_id, call_id, name, timestamp)
                        changed |= self._set_agent_locked(child, timestamp, phase="starting", activity="启动 %s 子 Agent" % child["name"])
                elif record_type == "tool.execution_start":
                    tool_name = clean_text(data.get("toolName"), 128)
                    tool_id = clean_id(data.get("toolCallId"))
                    arguments = data.get("arguments") if isinstance(data.get("arguments"), dict) else {}
                    if tool_name == "runSubagent":
                        name = clean_text(arguments.get("agentName"), 80)
                        child = self._ensure_child_locked("github-copilot", namespace, workspace, session_id, tool_id, name, timestamp)
                        changed |= self._set_agent_locked(child, timestamp, phase="running", activity="运行 %s 子 Agent" % child["name"])
                    else:
                        changed |= self._tool_start_locked("github-copilot", namespace, workspace, session_id, "", tool_id, tool_name, safe_target(target_from_arguments(arguments), ""), timestamp)
                elif record_type == "tool.execution_complete":
                    tool_id = clean_id(data.get("toolCallId"))
                    child_key = agent_id("github-copilot", namespace, session_id, tool_id)
                    if child_key in self.agents:
                        changed |= self._finish_agent_locked(self.agents[child_key], timestamp, SUBAGENT_STOP_TTL, bool(data.get("success", True)))
                    else:
                        changed |= self._tool_done_locked("github-copilot", namespace, session_id, "", tool_id, timestamp, not bool(data.get("success", True)))
            self.files_seen += 1
            if changed:
                self._publish_locked()

    def apply_copilot_chat_records(self, path, records):
        match = CHAT_SESSION_RE.search(path)
        if not match:
            return
        workspace_id = match.group(1)
        namespace, workspace = workspace_context(
            "github-copilot",
            os.path.join(USER_DATA, "workspaceStorage", workspace_id, "GitHub.copilot-chat", "transcripts", "%s.jsonl" % Path(path).stem),
            "",
        )
        session_id = clean_id(Path(path).stem)
        latest = {}
        for record in records:
            for part in iter_copilot_tool_parts(record):
                tool_id = clean_id(part.get("toolCallId"))
                if tool_id:
                    latest[tool_id] = part
        if not latest:
            return
        changed = False
        timestamp = now_ms()
        with self.lock:
            if path not in self.copilot_parts and len(self.copilot_parts) >= MAX_COPILOT_SESSION_CACHES:
                self.copilot_parts.pop(next(iter(self.copilot_parts)), None)
            state = self.copilot_parts.setdefault(path, {})
            for tool_id, part in latest.items():
                previous = state.get(tool_id)
                state[tool_id] = {
                    "complete": bool(part.get("isComplete")),
                    "error": bool(part.get("isError")),
                    "tool": clean_text(part.get("toolId"), 128),
                    "child": clean_id(part.get("subAgentInvocationId")),
                }
                if len(state) > MAX_COPILOT_PARTS_PER_SESSION:
                    state.pop(next(iter(state)), None)
                tool_name = clean_text(part.get("toolId"), 128)
                child_id = clean_id(part.get("subAgentInvocationId"))
                complete = bool(part.get("isComplete"))
                error = bool(part.get("isError"))
                specific = part.get("toolSpecificData") if isinstance(part.get("toolSpecificData"), dict) else {}
                if tool_name == "runSubagent":
                    name = clean_text(specific.get("agentName"), 80)
                    child_key = agent_id("github-copilot", namespace, session_id, tool_id)
                    if previous is None and complete and child_key not in self.agents:
                        continue
                    child = self._ensure_child_locked("github-copilot", namespace, workspace, session_id, tool_id, name, timestamp)
                    if previous is None and complete and child.get("completedAt"):
                        continue
                    if complete:
                        changed |= self._finish_agent_locked(child, timestamp, SUBAGENT_STOP_TTL, not error)
                    else:
                        changed |= self._set_agent_locked(child, timestamp, phase="running", activity="运行 %s 子 Agent" % child["name"])
                    continue
                if previous is None and complete:
                    active_elsewhere = any(tool_id in agent["activeTools"] for agent in self.agents.values())
                    if not active_elsewhere:
                        continue
                if complete:
                    changed |= self._tool_done_locked("github-copilot", namespace, session_id, child_id, tool_id, timestamp, error)
                else:
                    changed |= self._tool_start_locked("github-copilot", namespace, workspace, session_id, child_id, tool_id, tool_name, "", timestamp)
            self.files_seen += 1
            if changed:
                self._publish_locked()

    def sync_claude_sessions(self, sessions):
        active = set()
        changed = False
        timestamp = now_ms()
        with self.lock:
            for meta in sessions:
                session_id = clean_id(meta.get("sessionId"))
                cwd = clean_text(meta.get("cwd"), 2048)
                if not session_id:
                    continue
                namespace, workspace = workspace_context("claude-code", "", cwd)
                key = agent_id("claude-code", namespace, session_id)
                active.add(key)
                name = clean_text(meta.get("name"), 80) or "Claude Code"
                existed = key in self.agents
                agent = self._ensure_main_locked("claude-code", namespace, workspace, session_id, int(meta.get("startedAt") or timestamp), name)
                changed |= not existed
                if agent.get("removeAfter"):
                    agent.pop("removeAfter", None)
                    agent.pop("completedAt", None)
                    if not agent["activeTools"]:
                        agent["phase"] = "idle"
                        agent["activity"] = "空闲"
                    changed = True
                if agent.get("source") != "session-file":
                    agent["source"] = "session-file"
                    changed = True
                agent["sessionSeenAt"] = timestamp
            for key, agent in list(self.agents.items()):
                if (agent["provider"] == "claude-code" and agent["kind"] == "main"
                        and agent.get("source") == "session-file" and key not in active
                        and not agent.get("completedAt")):
                    changed |= self._finish_agent_locked(agent, timestamp, SESSION_END_TTL, True)
            if changed:
                self._publish_locked()

    def apply_claude_records(self, path, records, parent_session_id="", child_id="", fallback_cwd="", fallback_name=""):
        changed = False
        recent_after = now_ms() - STALE_TTL * 1000
        with self.lock:
            for record in records:
                session_id = clean_id(record.get("sessionId")) or clean_id(parent_session_id) or clean_id(Path(path).stem)
                record_cwd = clean_text(record.get("cwd"), 2048)
                cwd = clean_text(fallback_cwd, 2048) or record_cwd
                namespace, workspace = workspace_context("claude-code", "", cwd)
                timestamp = parse_time(record.get("timestamp"))
                if timestamp < recent_after:
                    continue
                target_child = clean_id(record.get("agentId")) or clean_id(child_id)
                message = record.get("message") if isinstance(record.get("message"), dict) else {}
                content = message.get("content") if isinstance(message.get("content"), list) else []
                if target_child or record.get("isSidechain") is True:
                    target_child = target_child or clean_id(Path(path).stem)
                    self._ensure_child_locked("claude-code", namespace, workspace, session_id, target_child, "", timestamp)
                else:
                    self._ensure_main_locked("claude-code", namespace, workspace, session_id, timestamp, fallback_name)
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    if part.get("type") == "tool_use":
                        changed |= self._tool_start_locked("claude-code", namespace, workspace, session_id, target_child, clean_id(part.get("id")), clean_text(part.get("name"), 128), safe_target(target_from_arguments(part.get("input")), cwd), timestamp)
                    elif part.get("type") == "tool_result":
                        changed |= self._tool_done_locked("claude-code", namespace, session_id, target_child, clean_id(part.get("tool_use_id")), timestamp, bool(part.get("is_error")))
            self.files_seen += 1
            if changed:
                self._publish_locked()

    def cleanup(self):
        timestamp = now_ms()
        changed = False
        with self.lock:
            for key, agent in list(self.agents.items()):
                remove_after = agent.get("removeAfter")
                registered = (agent.get("source") == "session-file"
                              and timestamp - int(agent.get("sessionSeenAt") or 0) < max(10, int(POLL_INTERVAL * 4 + 2)) * 1000)
                stale = not registered and timestamp - agent["updatedAt"] > STALE_TTL * 1000
                if (remove_after and timestamp >= remove_after) or stale:
                    del self.agents[key]
                    changed = True
            if changed:
                self._publish_locked()
        return changed

    def _process_event_locked(self, event):
        provider = event["provider"]
        namespace = event["namespace"]
        workspace = event["workspace"]
        session_id = event["session_id"]
        timestamp = event["timestamp"]
        child_id = event["child_id"]
        kind = event["event"]
        if kind == "session_start":
            agent = self._ensure_main_locked(provider, namespace, workspace, session_id, timestamp, event["agent_type"])
            return self._set_agent_locked(agent, timestamp, phase="starting", activity="会话已开始")
        if kind == "session_end":
            return self._finish_agent_locked(self._ensure_main_locked(provider, namespace, workspace, session_id, timestamp), timestamp, SESSION_END_TTL, True)
        if kind == "subagent_start":
            child = self._ensure_child_locked(provider, namespace, workspace, session_id, child_id or "subagent", event["agent_type"], timestamp)
            child["source"] = "hook"
            return self._set_agent_locked(child, timestamp, phase="starting", activity="启动 %s 子 Agent" % child["name"])
        if kind == "subagent_stop":
            child = self._find_child_locked(provider, namespace, session_id, child_id)
            return self._finish_agent_locked(child, timestamp, SUBAGENT_STOP_TTL, True) if child else False
        if kind == "pre_tool_use":
            return self._tool_start_locked(provider, namespace, workspace, session_id, child_id, event["tool_id"], event["tool_name"], event["target"], timestamp)
        if kind in ("post_tool_use", "tool_error"):
            return self._tool_done_locked(provider, namespace, session_id, child_id, event["tool_id"], timestamp, kind == "tool_error")
        agent = self._find_child_locked(provider, namespace, session_id, child_id) if child_id else self._ensure_main_locked(provider, namespace, workspace, session_id, timestamp)
        if kind == "waiting":
            return self._set_agent_locked(agent, timestamp, phase="waiting", activity="等待输入", clear_tools=True)
        if kind == "stop":
            return self._finish_agent_locked(agent, timestamp, SUBAGENT_STOP_TTL if agent["kind"] == "subagent" else MAIN_STOP_TTL, True, idle=True)
        return False

    def _ensure_main_locked(self, provider, namespace, workspace, session_id, timestamp, name=""):
        key = agent_id(provider, namespace, session_id)
        agent = self.agents.get(key)
        if agent:
            if name and agent["name"].startswith(("Copilot ", "Claude ")):
                agent["name"] = clean_text(name, 80)
            return agent
        default_name = "Copilot %s" % session_id[:8] if provider == "github-copilot" else "Claude %s" % session_id[:8]
        self._reserve_agent_slot_locked()
        agent = self._new_agent(key, provider, "main", "", session_id, namespace, workspace, clean_text(name, 80) or default_name, timestamp)
        self.agents[key] = agent
        return agent

    def _ensure_child_locked(self, provider, namespace, workspace, session_id, child_id, name, timestamp):
        child_id = clean_id(child_id) or "subagent"
        key = agent_id(provider, namespace, session_id, child_id)
        agent = self.agents.get(key)
        if agent:
            if name:
                agent["name"] = clean_text(name, 80)
            return agent
        parent = self._ensure_main_locked(provider, namespace, workspace, session_id, timestamp)
        self._reserve_agent_slot_locked()
        agent = self._new_agent(key, provider, "subagent", parent["id"], session_id, namespace, workspace, clean_text(name, 80) or "Subagent %s" % child_id[:8], timestamp)
        agent["childId"] = child_id
        self.agents[key] = agent
        return agent

    def _new_agent(self, key, provider, kind, parent_id, session_id, namespace, workspace, name, timestamp):
        return {
            "id": key,
            "provider": provider,
            "kind": kind,
            "parentId": parent_id,
            "sessionId": session_id,
            "namespace": namespace,
            "workspace": workspace,
            "name": name,
            "phase": "idle",
            "activity": "空闲",
            "toolName": "",
            "target": "",
            "startedAt": timestamp,
            "updatedAt": timestamp,
            "activeTools": {},
        }

    def _reserve_agent_slot_locked(self):
        if len(self.agents) < MAX_AGENTS:
            return
        candidates = sorted(self.agents.values(), key=lambda agent: (bool(agent["activeTools"]), agent["updatedAt"]))
        if candidates:
            self.agents.pop(candidates[0]["id"], None)

    def _find_child_locked(self, provider, namespace, session_id, child_id):
        if child_id:
            return self.agents.get(agent_id(provider, namespace, session_id, child_id))
        children = [agent for agent in self.agents.values() if agent["provider"] == provider and agent["namespace"] == namespace and agent["sessionId"] == session_id and agent["kind"] == "subagent" and not agent.get("completedAt")]
        return children[0] if len(children) == 1 else None

    def _resolve_tool_agent_locked(self, provider, namespace, workspace, session_id, child_id, tool_id, timestamp):
        if child_id:
            desired = self._ensure_child_locked(provider, namespace, workspace, session_id, child_id, "", timestamp)
            for agent in self.agents.values():
                if agent is desired:
                    continue
                tool = agent["activeTools"].pop(tool_id, None)
                if tool:
                    desired["activeTools"][tool_id] = tool
                if tool and not agent["activeTools"]:
                    self._set_agent_locked(agent, timestamp, phase="idle", activity="空闲", tool_name="", target="")
            return desired
        for agent in self.agents.values():
            if agent["provider"] == provider and agent["namespace"] == namespace and agent["sessionId"] == session_id and tool_id in agent["activeTools"]:
                return agent
        children = [agent for agent in self.agents.values() if agent["provider"] == provider and agent["namespace"] == namespace and agent["sessionId"] == session_id and agent["kind"] == "subagent" and not agent.get("completedAt")]
        if len(children) == 1:
            return children[0]
        if len(children) > 1:
            self.ambiguous_tools += 1
        return self._ensure_main_locked(provider, namespace, workspace, session_id, timestamp)

    def _tool_start_locked(self, provider, namespace, workspace, session_id, child_id, tool_id, tool_name, target, timestamp):
        tool_id = tool_id or "tool-%d" % timestamp
        agent = self._resolve_tool_agent_locked(provider, namespace, workspace, session_id, child_id, tool_id, timestamp)
        status = tool_status(tool_name)
        existing = agent["activeTools"].get(tool_id)
        if existing and not target:
            target = existing.get("target", "")
        if (existing and existing.get("name") == (tool_name or "tool")
            and existing.get("status") == status
            and existing.get("target", "") == target):
            return False
        tool = {"id": tool_id, "name": tool_name or "tool", "status": status, "startedAt": timestamp}
        if target:
            tool["target"] = target
        before = json.dumps(public_agent(agent), sort_keys=True, ensure_ascii=True)
        if tool_id not in agent["activeTools"] and len(agent["activeTools"]) >= MAX_TOOLS_PER_AGENT:
            oldest = min(agent["activeTools"].values(), key=lambda item: item["startedAt"])
            agent["activeTools"].pop(oldest["id"], None)
        agent["activeTools"][tool_id] = tool
        agent.pop("completedAt", None)
        agent.pop("removeAfter", None)
        agent["phase"] = status if status != "other" else "running"
        agent["activity"] = activity_for_tool(tool_name, target)
        agent["toolName"] = tool_name
        agent["target"] = target
        agent["updatedAt"] = max(agent["updatedAt"], timestamp)
        return before != json.dumps(public_agent(agent), sort_keys=True, ensure_ascii=True)

    def _tool_done_locked(self, provider, namespace, session_id, child_id, tool_id, timestamp, failed):
        agent = None
        changed = False
        if child_id:
            agent = self._find_child_locked(provider, namespace, session_id, child_id)
            for candidate in self.agents.values():
                if candidate is agent:
                    continue
                if candidate["provider"] == provider and candidate["namespace"] == namespace and candidate["sessionId"] == session_id:
                    removed = candidate["activeTools"].pop(tool_id, None)
                    if removed:
                        changed = True
                        if agent is None:
                            agent = self._ensure_child_locked(provider, namespace, candidate["workspace"], session_id, child_id, "", timestamp)
                        if not candidate["activeTools"]:
                            changed |= self._set_agent_locked(candidate, timestamp, phase="idle", activity="空闲", tool_name="", target="")
        for candidate in self.agents.values():
            if agent:
                break
            if candidate["provider"] == provider and candidate["namespace"] == namespace and candidate["sessionId"] == session_id and tool_id in candidate["activeTools"]:
                agent = candidate
                break
        if not agent:
            return changed
        changed |= bool(agent["activeTools"].pop(tool_id, None))
        if failed:
            changed |= self._set_agent_locked(agent, timestamp, phase="error", activity="工具执行失败")
        elif agent["activeTools"]:
            latest = max(agent["activeTools"].values(), key=lambda item: item["startedAt"])
            changed |= self._set_agent_locked(agent, timestamp, phase=latest["status"] if latest["status"] != "other" else "running", activity=activity_for_tool(latest["name"], latest.get("target", "")), tool_name=latest["name"], target=latest.get("target", ""))
        else:
            changed |= self._set_agent_locked(agent, timestamp, phase="idle", activity="空闲", tool_name="", target="")
        return changed

    def _set_agent_locked(self, agent, timestamp, phase=None, activity=None, tool_name=None, target=None, clear_tools=False):
        if not agent:
            return False
        before = (agent["phase"], agent["activity"], agent.get("toolName"), agent.get("target"), len(agent["activeTools"]), agent.get("completedAt"), agent.get("removeAfter"))
        if clear_tools:
            agent["activeTools"].clear()
        if phase is not None:
            agent["phase"] = phase
        if activity is not None:
            agent["activity"] = activity
        if tool_name is not None:
            agent["toolName"] = tool_name
        if target is not None:
            agent["target"] = target
        agent["updatedAt"] = max(agent["updatedAt"], timestamp)
        if phase not in ("done", "error"):
            agent.pop("completedAt", None)
            agent.pop("removeAfter", None)
        after = (agent["phase"], agent["activity"], agent.get("toolName"), agent.get("target"), len(agent["activeTools"]), agent.get("completedAt"), agent.get("removeAfter"))
        return before != after

    def _finish_agent_locked(self, agent, timestamp, ttl, success, idle=False):
        if not agent:
            return False
        phase = "idle" if idle else ("done" if success else "error")
        activity = "空闲" if idle else ("已完成" if success else "执行失败")
        if (agent.get("completedAt") and agent.get("phase") == phase
                and agent.get("activity") == activity and not agent["activeTools"]):
            return False
        agent["activeTools"].clear()
        agent["phase"] = phase
        agent["activity"] = activity
        agent["toolName"] = ""
        agent["target"] = ""
        agent["updatedAt"] = max(agent["updatedAt"], timestamp)
        agent["completedAt"] = timestamp
        agent["removeAfter"] = timestamp + ttl * 1000
        return True

    def _duplicate(self, key):
        timestamp = time.monotonic()
        while self.dedupe and timestamp - next(iter(self.dedupe.values())) > 10:
            self.dedupe.popitem(last=False)
        previous = self.dedupe.get(key)
        self.dedupe[key] = timestamp
        self.dedupe.move_to_end(key)
        while len(self.dedupe) > 4096:
            self.dedupe.popitem(last=False)
        return previous is not None and timestamp - previous < 5

    def _publish_locked(self):
        self.revision += 1
        snapshot = self.snapshot()
        for channel in list(self.clients):
            try:
                if channel.full():
                    channel.get_nowait()
                channel.put_nowait(snapshot)
            except queue.Empty:
                pass
            except queue.Full:
                pass
        self.persist_event.set()

    def _load(self):
        try:
            data = json.loads(Path(self.state_file).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        timestamp = now_ms()
        self.revision = int(data.get("revision") or 0)
        for item in data.get("agents") or []:
            if not isinstance(item, dict) or timestamp - int(item.get("updatedAt") or 0) > STALE_TTL * 1000:
                continue
            try:
                namespace = clean_text(item.pop("_namespace", ""), 2048) or "restored:%s" % item["workspace"]
                remove_after = item.pop("_removeAfter", None)
                source = item.pop("_source", None)
                session_seen_at = item.pop("_sessionSeenAt", None)
                agent = dict(item)
                agent["namespace"] = namespace
                agent["activeTools"] = {tool["id"]: dict(tool) for tool in item.get("activeTools") or [] if isinstance(tool, dict) and tool.get("id")}
                if isinstance(remove_after, (int, float)):
                    agent["removeAfter"] = int(remove_after)
                elif agent.get("completedAt"):
                    ttl = SUBAGENT_STOP_TTL if agent.get("kind") == "subagent" else MAIN_STOP_TTL
                    agent["removeAfter"] = int(agent["completedAt"]) + ttl * 1000
                if isinstance(source, str) and source:
                    agent["source"] = source
                if isinstance(session_seen_at, (int, float)):
                    agent["sessionSeenAt"] = int(session_seen_at)
                self.agents[agent["id"]] = agent
            except (KeyError, TypeError, ValueError):
                continue

    def _persist_worker(self):
        while not self.stopped.is_set():
            self.persist_event.wait(1)
            if self.stopped.is_set():
                break
            self.persist_event.clear()
            time.sleep(0.15)
            with self.lock:
                data = self.snapshot()
                for public in data["agents"]:
                    private = self.agents.get(public["id"])
                    public["_namespace"] = private.get("namespace", "") if private else ""
                    if private and private.get("removeAfter"):
                        public["_removeAfter"] = private["removeAfter"]
                    if private and private.get("source"):
                        public["_source"] = private["source"]
                    if private and private.get("sessionSeenAt"):
                        public["_sessionSeenAt"] = private["sessionSeenAt"]
            try:
                path = Path(self.state_file)
                path.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=".%s." % path.name, suffix=".tmp", delete=False) as handle:
                    handle.write(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
                    temp = Path(handle.name)
                os.chmod(temp, 0o600)
                os.replace(temp, path)
            except OSError:
                pass


class JsonlCursor:
    def __init__(self):
        self.inode = None
        self.offset = 0
        self.remainder = b""

    def read(self, path):
        try:
            stat = os.stat(path)
        except OSError:
            return []
        if self.inode != stat.st_ino or stat.st_size < self.offset:
            self.inode = stat.st_ino
            self.offset = max(0, stat.st_size - MAX_FILE_TAIL)
            self.remainder = b""
        try:
            with open(path, "rb") as handle:
                handle.seek(self.offset)
                data = handle.read()
                self.offset = handle.tell()
        except OSError:
            return []
        if not data:
            return []
        if self.offset - len(data) > 0 and not self.remainder:
            split = data.find(b"\n")
            data = data[split + 1:] if split >= 0 else b""
        data = self.remainder + data
        lines = data.split(b"\n")
        self.remainder = lines.pop() if lines else b""
        records = []
        for line in lines:
            if not line.strip():
                continue
            try:
                value = json.loads(line.decode("utf-8"))
                if isinstance(value, dict):
                    records.append(value)
            except (UnicodeDecodeError, ValueError):
                continue
        return records


def iter_copilot_tool_parts(value):
    if isinstance(value, dict):
        if value.get("kind") == "toolInvocationSerialized" and value.get("toolCallId"):
            yield value
        for child in value.values():
            yield from iter_copilot_tool_parts(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_copilot_tool_parts(child)


class Collector:
    def __init__(self, broker):
        self.broker = broker
        self.cursors = {}
        self.stop_event = threading.Event()

    def start(self):
        threading.Thread(target=self.run, daemon=True, name="pixel-collector").start()

    def stop(self):
        self.stop_event.set()

    def run(self):
        while not self.stop_event.is_set():
            self.broker.loop_at = time.time()
            try:
                self.scan_copilot()
                sessions = self.read_claude_sessions()
                self.broker.sync_claude_sessions(sessions)
                self.scan_claude(sessions)
                self.broker.cleanup()
            except BaseException as err:
                log("collector error %s: %s" % (type(err).__name__, err))
            self.stop_event.wait(POLL_INTERVAL)

    def scan_copilot(self):
        pattern = os.path.join(USER_DATA, "workspaceStorage", "*", "GitHub.copilot-chat", "transcripts", "*.jsonl")
        self._scan(pattern, self.broker.apply_copilot_records)
        chat_pattern = os.path.join(USER_DATA, "workspaceStorage", "*", "chatSessions", "*.jsonl")
        self._scan(chat_pattern, self.broker.apply_copilot_chat_records)

    def read_claude_sessions(self):
        out = []
        for path in glob.glob(os.path.join(CLAUDE_HOME, "sessions", "*.json")):
            try:
                data = json.loads(Path(path).read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    out.append(data)
            except (OSError, ValueError):
                continue
        return out

    def scan_claude(self, sessions):
        for meta in sessions:
            session_id = clean_id(meta.get("sessionId"))
            if not session_id:
                continue
            cwd = clean_text(meta.get("cwd"), 2048)
            name = clean_text(meta.get("name"), 80)
            for path in glob.glob(os.path.join(CLAUDE_HOME, "projects", "*", "%s.jsonl" % session_id)):
                self._read_apply(path, lambda p, records, sid=session_id, base=cwd, label=name: self.broker.apply_claude_records(p, records, sid, "", base, label))
            pattern = os.path.join(CLAUDE_HOME, "projects", "*", session_id, "subagents", "*.jsonl")
            for path in glob.glob(pattern):
                child_id = clean_id(Path(path).stem.removeprefix("agent-"))
                self._read_apply(path, lambda p, records, sid=session_id, cid=child_id, base=cwd, label=name: self.broker.apply_claude_records(p, records, sid, cid, base, label))

    def _scan(self, pattern, callback):
        cutoff = time.time() - RECENT_TRANSCRIPT_AGE
        for path in glob.glob(pattern):
            try:
                if path not in self.cursors and os.stat(path).st_mtime < cutoff:
                    continue
            except OSError:
                continue
            self._read_apply(path, callback)

    def _read_apply(self, path, callback):
        cursor = self.cursors.setdefault(path, JsonlCursor())
        records = cursor.read(path)
        if records:
            callback(path, records)


def make_handler(broker):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        timeout = 30

        def do_GET(self):
            if not self._authorized():
                self.close_connection = True
                return self._json(403, {"error": "forbidden"})
            path = urlsplit(self.path).path
            if path == "/snapshot":
                return self._json(200, broker.snapshot())
            if path == "/status":
                return self._json(200, broker.status())
            if path == "/events":
                return self._events()
            return self.send_error(404)

        def do_POST(self):
            if urlsplit(self.path).path != "/hook":
                return self.send_error(404)
            if not self._authorized():
                self.close_connection = True
                return self._json(403, {"error": "forbidden"})
            if self.headers.get_content_type() != "application/json":
                return self._json(415, {"error": "application/json required"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                return self._json(400, {"error": "invalid content length"})
            if length <= 0 or length > MAX_BODY:
                return self._json(413, {"error": "payload too large"})
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._json(400, {"error": "invalid json"})
            if not isinstance(payload, dict):
                return self._json(400, {"error": "object required"})
            accepted = broker.process_hook(payload)
            return self._json(200, {"ok": True, "accepted": accepted, "revision": broker.revision})

        def do_PUT(self):
            self.send_error(405)

        def do_DELETE(self):
            self.send_error(405)

        def _authorized(self):
            supplied = self.headers.get("X-Multi-Agent-Pixel-Office-Token", "")
            return bool(supplied) and secrets.compare_digest(supplied, broker.token)

        def _json(self, status, value):
            body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _events(self):
            channel = broker.subscribe()
            born = time.time()
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache, no-transform")
                self.send_header("Connection", "keep-alive")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                self._event("snapshot", broker.snapshot())
                while time.time() - born < SSE_MAX_LIFETIME:
                    try:
                        snapshot = channel.get(timeout=SSE_HEARTBEAT)
                        if snapshot is None:
                            break
                        self._event("revision", snapshot)
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                broker.unsubscribe(channel)

        def _event(self, name, value):
            data = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            self.wfile.write(("event: %s\ndata: %s\n\n" % (name, data)).encode("utf-8"))
            self.wfile.flush()

        def log_message(self, *_args):
            pass

    return Handler


def log(message):
    try:
        sys.stdout.write("[pixel-broker] %s %s\n" % (time.strftime("%H:%M:%S"), message))
        sys.stdout.flush()
    except Exception:
        pass


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("MULTI_AGENT_PIXEL_OFFICE_PORT", "7933")))
    parser.add_argument("--no-collectors", action="store_true")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args(argv)
    broker = Broker()
    if args.selftest:
        print(json.dumps(broker.status(), ensure_ascii=False))
        return 0
    collector = None if args.no_collectors else Collector(broker)
    if collector:
        collector.start()
    ThreadingHTTPServer.allow_reuse_address = True
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(broker))
    except OSError as err:
        log("port %d unavailable: %s" % (args.port, err))
        return 1
    server.daemon_threads = True
    stop = threading.Event()

    def shutdown(_signum, _frame):
        if stop.is_set():
            return
        stop.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    log("listening on 127.0.0.1:%d" % args.port)
    try:
        server.serve_forever()
    finally:
        if collector:
            collector.stop()
        broker.stop()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
