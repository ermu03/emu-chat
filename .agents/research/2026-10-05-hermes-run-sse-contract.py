"""Exercise the actual Hermes run handler without launching an agent or a server.

Usage: python3 .agents/research/2026-10-05-hermes-run-sse-contract.py /path/to/hermes-agent
Only transport/auth are stubbed. Functions are compiled directly from upstream source.
"""

import __future__
import ast
import asyncio
import json
import logging
from pathlib import Path
import sys
import time
from types import SimpleNamespace


class Response:
    fail = False

    def __init__(self, **kwargs):
        self.frames = []

    async def prepare(self, request):
        pass

    async def write(self, frame):
        if self.fail:
            raise ConnectionResetError("isolated disconnect")
        self.frames.append(frame)


async def verify(root):
    namespace = {
        "asyncio": asyncio, "json": json, "time": time,
        "logger": logging.getLogger("contract"),
        "web": SimpleNamespace(StreamResponse=Response),
        "_run_not_found": lambda *args: 404,
    }
    for path, names in [
        ("gateway/platforms/api_server.py", {"_sse_frame"}),
        ("gateway/platforms/api_server_runs.py", {
            "_run_event", "_handle_run_events", "_drop_run_transport", "_forget_run",
        }),
    ]:
        source = ast.parse((root / path).read_text())
        selected = [node for node in source.body if getattr(node, "name", None) in names]
        assert len(selected) == len(names)
        module = ast.Module(body=selected, type_ignores=[])
        exec(compile(module, str(root / path), "exec", flags=__future__.annotations.compiler_flag), namespace)

    api = SimpleNamespace(
        _openai_error=None, _sse_frame=namespace["_sse_frame"],
        CHAT_COMPLETIONS_SSE_KEEPALIVE_SECONDS=10,
    )
    request = SimpleNamespace(match_info={"run_id": "run_test"}, headers={"Last-Event-ID": "999"})
    for disconnect in (False, True):
        queue = asyncio.Queue()
        queue.put_nowait(namespace["_run_event"]("run_test", "message.delta", text="same"))
        queue.put_nowait(namespace["_run_event"]("run_test", "message.delta", text="same"))
        if not disconnect:
            queue.put_nowait(None)
        owner = SimpleNamespace(
            _check_auth=lambda request: None, _request_owns_run=lambda request, run: True,
            _release_run_owner_if_forgotten=lambda run: None,
            _run_streams={"run_test": queue}, _run_streams_created={"run_test": time.time()},
            _run_stream_subscribers=set(), _run_statuses={"run_test": {"status": "running"}},
        )
        Response.fail = disconnect
        response = await namespace["_handle_run_events"](owner, request, _api_server=api)
        assert not owner._run_streams and not owner._run_stream_subscribers
        assert owner._run_statuses["run_test"]["status"] == "running"
        if not disconnect:
            assert len(response.frames) == 3  # both identical deltas plus close comment
            assert all(not frame.startswith(b"id:") for frame in response.frames)
            assert b"stream closed" in response.frames[-1]
        assert await namespace["_handle_run_events"](owner, request, _api_server=api) == 404
        print(f"disconnect={disconnect}: no replay/cursor, transport deleted, status retained, resubscribe=404")


asyncio.run(verify(Path(sys.argv[1])))
