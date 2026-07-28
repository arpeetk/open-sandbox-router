"""Dependency-free OSR client using only the Python standard library."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional


class OsrError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


@dataclass
class ExecResult:
    stdout: str = ""
    stderr: str = ""
    code: int = 0


class OSR:
    def __init__(
        self,
        base_url: str = "http://localhost:8080",
        api_key: Optional[str] = None,
        tenant: Optional[str] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.headers = {}
        if api_key:
            self.headers["authorization"] = f"Bearer {api_key}"
        if tenant:
            self.headers["x-osr-tenant"] = tenant

    def _headers(self, has_body: bool) -> Dict[str, str]:
        h = dict(self.headers)
        if has_body:
            h["content-type"] = "application/json"
        return h

    # ---- low-level ---------------------------------------------------------

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.base_url + path, data=data, method=method, headers=self._headers(data is not None)
        )
        try:
            with urllib.request.urlopen(req) as res:
                if res.status == 204:
                    return None
                raw = res.read().decode()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            payload = e.read().decode()
            try:
                err = json.loads(payload).get("error", {})
                raise OsrError(err.get("code", "Internal"), err.get("message", str(e))) from None
            except json.JSONDecodeError:
                raise OsrError("Internal", payload or str(e)) from None

    def _stream(self, path: str, body: dict) -> Iterator[dict]:
        data = json.dumps(body).encode()
        req = urllib.request.Request(self.base_url + path, data=data, method="POST", headers=self._headers(True))
        with urllib.request.urlopen(req) as res:
            for line in res:
                text = line.decode().strip()
                if text.startswith("data:"):
                    event = json.loads(text[5:].strip())
                    if isinstance(event, dict) and event.get("error"):
                        err = event["error"]
                        raise OsrError(err.get("code", "Internal"), err.get("message", ""))
                    yield event

    # ---- high-level --------------------------------------------------------

    def providers(self) -> List[dict]:
        return self._request("GET", "/v1/providers")

    def route_plan(self, **req: Any) -> dict:
        return self._request("POST", "/v1/route/plan", _create_body(req))

    def create(self, **req: Any) -> "Sandbox":
        outcome = self._request("POST", "/v1/sandboxes", _create_body(req))
        return Sandbox(self, outcome["sandbox"], outcome.get("attempts", []))

    def get(self, sandbox_id: str) -> "Sandbox":
        return Sandbox(self, self._request("GET", f"/v1/sandboxes/{sandbox_id}"), [])

    def list(self) -> List["Sandbox"]:
        return [Sandbox(self, s, []) for s in self._request("GET", "/v1/sandboxes")]

    def restore(self, provider: str, snapshot_id: str, **req: Any) -> "Sandbox":
        """Create a new sandbox restored from a previous `sandbox.snapshot()`."""
        req["from_snapshot"] = {"provider": provider, "snapshotId": snapshot_id}
        return self.create(**req)


@dataclass
class Sandbox:
    client: OSR
    data: Dict[str, Any]
    attempts: List[dict] = field(default_factory=list)

    @property
    def id(self) -> str:
        return self.data["id"]

    @property
    def provider(self) -> str:
        return self.data["provider"]

    @property
    def capabilities(self) -> List[str]:
        return self.data.get("capabilities", [])

    def exec(self, cmd: str, args: Optional[List[str]] = None) -> Iterator[dict]:
        return self.client._stream(f"/v1/sandboxes/{self.id}/exec", {"cmd": cmd, "args": args or []})

    def run(self, cmd: str, args: Optional[List[str]] = None) -> ExecResult:
        result = ExecResult()
        for ev in self.exec(cmd, args):
            if ev["type"] == "stdout":
                result.stdout += ev["data"]
            elif ev["type"] == "stderr":
                result.stderr += ev["data"]
            elif ev["type"] == "exit":
                result.code = ev["code"]
        return result

    def run_code(self, code: str, session: str = "default") -> Iterator[dict]:
        return self.client._stream(f"/v1/sandboxes/{self.id}/runCode", {"session": session, "code": code})

    def fs_write(self, path: str, content: str) -> None:
        self.client._request("POST", f"/v1/sandboxes/{self.id}/fs/write", {"path": path, "content": content})

    def fs_read(self, path: str) -> str:
        q = urllib.parse.quote(path)
        return self.client._request("GET", f"/v1/sandboxes/{self.id}/fs/read?path={q}")["content"]

    def expose_port(self, port: int) -> dict:
        return self.client._request("POST", f"/v1/sandboxes/{self.id}/ports", {"port": port})

    def destroy(self) -> None:
        self.client._request("DELETE", f"/v1/sandboxes/{self.id}")

    def pause(self) -> "Sandbox":
        """Pause the sandbox (provider-dependent — raises OsrError otherwise)."""
        self.data = self.client._request("POST", f"/v1/sandboxes/{self.id}/pause")
        return self

    def resume(self) -> "Sandbox":
        """Resume a paused sandbox."""
        self.data = self.client._request("POST", f"/v1/sandboxes/{self.id}/resume")
        return self

    def snapshot(self) -> Dict[str, str]:
        """Take a provider-native snapshot: {"provider": ..., "snapshotId": ...}."""
        return self.client._request("POST", f"/v1/sandboxes/{self.id}/snapshot")


def _create_body(req: Dict[str, Any]) -> Dict[str, Any]:
    """Map pythonic kwargs to the wire schema."""
    body: Dict[str, Any] = {}
    if "template" in req:
        body["template"] = req["template"]
    if "name" in req:
        body["name"] = req["name"]
    if "required" in req:
        body["requiredCapabilities"] = req["required"]
    if "preferred" in req:
        body["preferredCapabilities"] = req["preferred"]
    if "resources" in req:
        body["resources"] = req["resources"]
    if "ttl_seconds" in req:
        body["ttlSeconds"] = req["ttl_seconds"]
    if "routing" in req:
        body["routing"] = req["routing"]
    if "metadata" in req:
        body["metadata"] = req["metadata"]
    if "from_snapshot" in req:
        body["fromSnapshot"] = req["from_snapshot"]
    return body
