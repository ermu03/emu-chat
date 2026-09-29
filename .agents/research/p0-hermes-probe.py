"""Isolated emu-media compatibility probe for the installed Hermes checkout.

Run with the installed Hermes virtualenv and its source directory on PYTHONPATH.
The model and tool provider are simulated; no live gateway or paid API is used.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


PLUGIN = '''\
import base64
import hmac
import json
import os
from pathlib import Path

from aiohttp import web


def _record(event, **fields):
    path = Path(os.environ["EMU_MEDIA_PROBE_EVENTS"])
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"event": event, **fields}) + "\\n")


def _pre_llm(**kw):
    _record("pre_llm", session_id=kw.get("session_id"), turn_id=kw.get("turn_id"),
            has_manifest="<emu-media" in kw.get("user_message", ""))
    return {"context": "Verified image asset available for this turn."}


def _pre_tool(**kw):
    _record("pre_tool", tool_name=kw.get("tool_name"), session_id=kw.get("session_id"),
            turn_id=kw.get("turn_id"), tool_call_id=kw.get("tool_call_id"))
    if kw.get("tool_name") == "vision_analyze" and kw.get("args", {}).get("image_url") == "emu-media://asset-1":
        return {"action": "modify", "args": {"image_url": os.environ["EMU_MEDIA_PROBE_IMAGE"]}}
    if kw.get("tool_name") == "image_generate" and kw.get("args", {}).get("image_url") == "emu-media://asset-1":
        encoded = base64.b64encode(Path(os.environ["EMU_MEDIA_PROBE_IMAGE"]).read_bytes()).decode("ascii")
        return {"action": "modify", "args": {"image_url": "data:image/png;base64," + encoded}}
    return None


def _post_tool(**kw):
    _record("post_tool", tool_name=kw.get("tool_name"), session_id=kw.get("session_id"),
            turn_id=kw.get("turn_id"), tool_call_id=kw.get("tool_call_id"),
            status=kw.get("status"), result=kw.get("result"))


def _wire(app, _adapter):
    async def probe(request):
        expected = os.environ.get("EMU_MEDIA_API_KEY", "")
        actual = request.headers.get("Authorization", "")
        if not expected:
            return web.json_response({"error": "unavailable"}, status=503)
        if not hmac.compare_digest(actual, "Bearer " + expected):
            return web.json_response({"error": "unauthorized"}, status=401)
        return web.json_response({"ok": True})

    app.router.add_get("/v1/emu-media/probe", probe)


def register(ctx):
    ctx.register_hook("pre_llm_call", _pre_llm)
    ctx.register_hook("pre_tool_call", _pre_tool)
    ctx.register_hook("post_tool_call", _post_tool)
    ctx.register_platform_handler("api_server", _wire)
'''


async def main() -> None:
    with tempfile.TemporaryDirectory(prefix="emu-media-p0-") as temp:
        home = Path(temp)
        (home / "bundled").mkdir()
        image = home / "sample.png"
        from PIL import Image

        Image.new("RGB", (2, 2), "#123456").save(image)
        plugin = home / "plugins" / "emu-media-probe"
        plugin.mkdir(parents=True)
        (plugin / "plugin.yaml").write_text("name: emu-media-probe\nversion: 0.1.0\n", encoding="utf-8")
        (plugin / "__init__.py").write_text(PLUGIN, encoding="utf-8")
        (home / "config.yaml").write_text(
            "database:\n  journal_mode: wal\nplugins:\n  enabled:\n    - emu-media-probe\nterminal:\n  backend: local\n",
            encoding="utf-8",
        )
        events = home / "events.jsonl"
        os.environ.update({
            "HERMES_HOME": str(home),
            "HERMES_BUNDLED_PLUGINS": str(home / "bundled"),
            "EMU_MEDIA_API_KEY": "isolated-test-key",
            "EMU_MEDIA_PROBE_EVENTS": str(events),
            "EMU_MEDIA_PROBE_IMAGE": str(image),
        })

        from aiohttp import web
        from aiohttp.test_utils import TestClient, TestServer
        from gateway.config import PlatformConfig
        from gateway.platforms.api_server import APIServerAdapter
        from hermes_cli.plugins import discover_plugins, get_plugin_manager
        from hermes_state import SessionDB
        from model_tools import handle_function_call
        from agent.display import redact_tool_args_for_display
        from tools.image_generation_catalog import FAL_MODELS
        from tools.image_generation_tool import _confine_source_images, _prepare_fal_request
        from tools.image_source import ResolveContext, resolve_image_source
        from tools.registry import registry
        from plugins.image_gen.openai import _named_bytes_io
        from plugins.image_gen.openrouter import _to_image_url_part
        from plugins.image_gen.xai import _xai_image_field

        discover_plugins()
        manager = get_plugin_manager()
        factories = manager.get_platform_handler_factories("api_server")
        assert len(factories) == 1, factories

        adapter = APIServerAdapter(
            PlatformConfig(enabled=True, extra={"host": "127.0.0.1", "port": 0, "key": "isolated-hermes-key"})
        )
        db = SessionDB(home / "state.db")
        adapter._session_db = db
        app = web.Application(client_max_size=10_000_000)
        app["api_server_adapter"] = adapter
        for method, path, handler in adapter._http_route_table():
            if path in {"/v1/runs", "/v1/runs/{run_id}", "/api/sessions/{session_id}/messages"}:
                app.router.add_route(method, path, handler)
        adapter._wire_plugin_handlers(app)

        captured = {}

        def dispatch(name, args, **_kw):
            captured[name] = dict(args)
            return json.dumps({"success": True, "description": "test image"})

        def create_agent(**kwargs):
            session_id = kwargs["session_id"]
            agent = MagicMock()
            agent.session_id = session_id
            agent.session_prompt_tokens = 0
            agent.session_completion_tokens = 0
            agent.session_total_tokens = 0

            def run_conversation(*, user_message, **_kw):
                from hermes_cli.lifecycle import invoke_hook

                if db.get_session(session_id) is None:
                    db.create_session(session_id=session_id, source="api_server", model="probe")
                context = invoke_hook(
                    "pre_llm_call", session_id=session_id, task_id=session_id,
                    turn_id="turn-probe-1", user_message=user_message,
                    conversation_history=[], is_first_turn=True, model="probe", platform="api_server",
                )
                assert context == [{"context": "Verified image asset available for this turn."}], context
                db.append_message(session_id, "user", user_message)
                result = handle_function_call(
                    "vision_analyze", {"image_url": "emu-media://asset-1", "question": "What is this?"},
                    task_id=session_id, session_id=session_id, turn_id="turn-probe-1",
                    tool_call_id="call-probe-1", api_request_id="request-probe-1",
                    skip_tool_execution_middleware=True,
                )
                db.append_message(
                    session_id, "assistant", "", tool_calls=[{
                        "id": "call-probe-1", "type": "function", "function": {
                            "name": "vision_analyze", "arguments": json.dumps({
                                "image_url": "emu-media://asset-1", "question": "What is this?"
                            }),
                        },
                    }],
                )
                db.append_message(session_id, "tool", result, tool_call_id="call-probe-1", tool_name="vision_analyze")
                return {"final_response": "ok", "messages": [], "api_calls": 1}

            agent.run_conversation.side_effect = run_conversation
            return agent

        adapter._create_agent = create_agent
        prompt = 'Describe image.\n<emu-media version="1" operation_id="op_probe">asset-1</emu-media>'
        headers = {"Authorization": "Bearer isolated-hermes-key", "Idempotency-Key": "op_probe"}
        with patch.object(registry, "dispatch", side_effect=dispatch):
            async with TestClient(TestServer(app)) as client:
                for provided, expected in ((None, 401), ("Bearer wrong", 401),
                                           ("Bearer isolated-test-key", 200)):
                    plugin_headers = {} if provided is None else {"Authorization": provided}
                    response = await client.get("/v1/emu-media/probe", headers=plugin_headers)
                    assert response.status == expected, (response.status, await response.text())
                os.environ.pop("EMU_MEDIA_API_KEY")
                response = await client.get("/v1/emu-media/probe", headers={"Authorization": "Bearer isolated-test-key"})
                assert response.status == 503
                os.environ["EMU_MEDIA_API_KEY"] = "isolated-test-key"

                response = await client.post(
                    "/v1/runs", json={"session_id": "probe-session", "input": prompt}, headers=headers
                )
                assert response.status in (200, 202), (response.status, await response.text())
                accepted = await response.json()
                run_id = accepted["run_id"]
                for _ in range(200):
                    await asyncio.sleep(0.02)
                    status = await client.get(f"/v1/runs/{run_id}", headers=headers)
                    state = await status.json()
                    if state.get("status") in {"completed", "failed", "cancelled"}:
                        break
                assert state["status"] == "completed", state
                same = await client.post(
                    "/v1/runs", json={"session_id": "probe-session", "input": prompt}, headers=headers
                )
                assert (await same.json())["run_id"] == run_id
                different = await client.post(
                    "/v1/runs", json={"session_id": "probe-session", "input": prompt + " changed"}, headers=headers
                )
                assert different.status == 409, (different.status, await different.text())
                history = await client.get(
                    "/api/sessions/probe-session/messages?order=oldest", headers=headers
                )
                assert history.status == 200, (history.status, await history.text())
                rows = (await history.json())["data"]

                from run_agent import AIAgent

                tool_def = [{
                    "type": "function", "function": {
                        "name": "vision_analyze", "description": "Describe an image",
                        "parameters": {"type": "object", "properties": {}},
                    },
                }]
                tool_call = SimpleNamespace(
                    id="call-real-1", type="function", function=SimpleNamespace(
                        name="vision_analyze", arguments=json.dumps({
                            "image_url": "emu-media://asset-1", "question": "What is this?"
                        }),
                    ),
                )

                def response(content, finish_reason, tool_calls=None):
                    return SimpleNamespace(
                        choices=[SimpleNamespace(
                            message=SimpleNamespace(content=content, tool_calls=tool_calls),
                            finish_reason=finish_reason,
                        )], model="probe/model", usage=None,
                    )

                def create_real_agent(**kwargs):
                    agent = AIAgent(
                        api_key="isolated-model-key", base_url="https://example.invalid/v1",
                        model="probe/model", quiet_mode=True, verbose_logging=False,
                        skip_context_files=True, skip_memory=True,
                        session_id=kwargs["session_id"], session_db=db, platform="api_server",
                    )
                    agent.client = MagicMock()
                    agent.client.chat.completions.create.side_effect = [
                        response("", "tool_calls", [tool_call]),
                        response("Done", "stop"),
                    ]
                    agent._cached_system_prompt = "You are helpful."
                    agent._use_prompt_caching = False
                    agent.compression_enabled = False
                    agent.save_trajectories = False
                    return agent

                with patch("model_tools.get_tool_definitions", return_value=tool_def), patch(
                    "model_tools.check_toolset_requirements", return_value={}
                ), patch("agent.process_bootstrap.OpenAI"), patch(
                    "agent.turn_context._maybe_title_session_at_turn_start"
                ):
                    adapter._create_agent = create_real_agent
                    real_response = await client.post(
                        "/v1/runs",
                        json={"session_id": "probe-real-session", "input": prompt},
                        headers={"Authorization": "Bearer isolated-hermes-key", "Idempotency-Key": "op_real"},
                    )
                    assert real_response.status == 202, (real_response.status, await real_response.text())
                    real_run_id = (await real_response.json())["run_id"]
                    for _ in range(200):
                        await asyncio.sleep(0.02)
                        result_response = await client.get(
                            f"/v1/runs/{real_run_id}", headers=headers
                        )
                        real_state = await result_response.json()
                        if real_state.get("status") in {"completed", "failed", "cancelled"}:
                            break
                    assert real_state["status"] == "completed", real_state
                    real_history = await client.get(
                        "/api/sessions/probe-real-session/messages?order=oldest", headers=headers
                    )
                    assert real_history.status == 200, (real_history.status, await real_history.text())
                    real_rows = (await real_history.json())["data"]

                    tool_def[0]["function"]["name"] = "image_generate"
                    tool_call = SimpleNamespace(
                        id="call-edit-1", type="function", function=SimpleNamespace(
                            name="image_generate", arguments=json.dumps({
                                "image_url": "emu-media://asset-1", "prompt": "edit this image"
                            }),
                        ),
                    )
                    # A quiet API-server turn uses the real agent loop. The provider dispatch
                    # is simulated, so this checks the transport and persistence boundary.
                    log_buffer = io.StringIO()
                    log_handler = logging.StreamHandler(log_buffer)
                    logging.getLogger().addHandler(log_handler)
                    try:
                        edit_response = await client.post(
                            "/v1/runs",
                            json={"session_id": "probe-edit-session", "input": prompt},
                            headers={"Authorization": "Bearer isolated-hermes-key", "Idempotency-Key": "op_edit"},
                        )
                        assert edit_response.status == 202, (edit_response.status, await edit_response.text())
                        edit_run_id = (await edit_response.json())["run_id"]
                        for _ in range(200):
                            await asyncio.sleep(0.02)
                            edit_status = await client.get(f"/v1/runs/{edit_run_id}", headers=headers)
                            edit_state = await edit_status.json()
                            if edit_state.get("status") in {"completed", "failed", "cancelled"}:
                                break
                        assert edit_state["status"] == "completed", edit_state
                        edit_history = await client.get(
                            "/api/sessions/probe-edit-session/messages?order=oldest", headers=headers
                        )
                        edit_rows = (await edit_history.json())["data"]
                        edit_events = list(adapter._run_streams[edit_run_id]._queue)
                    finally:
                        logging.getLogger().removeHandler(log_handler)

        assert rows[0]["content"] == prompt, rows
        assert rows[1]["tool_calls"][0]["id"] == "call-probe-1", rows
        assert rows[2]["tool_call_id"] == "call-probe-1", rows
        assert any(row["role"] == "user" and row["content"] == prompt for row in real_rows), real_rows
        assert any(row["role"] == "tool" and row.get("tool_call_id") == "call-real-1" for row in real_rows), real_rows
        assert captured["vision_analyze"]["image_url"] == str(image), captured
        edit_uri = captured["image_generate"]["image_url"]
        assert edit_uri == "data:image/png;base64," + base64.b64encode(image.read_bytes()).decode("ascii")
        assert edit_uri not in json.dumps(edit_rows) and edit_uri not in json.dumps(edit_events)
        assert edit_uri not in log_buffer.getvalue()
        resolved = await resolve_image_source(str(image), ResolveContext(task_id="probe-session"))
        assert resolved.data == image.read_bytes() and resolved.mime == "image/png"
        assert _named_bytes_io(str(image)).read() == image.read_bytes()
        assert _to_image_url_part(str(image)).startswith("data:image/png;base64,")
        assert _xai_image_field(str(image))["url"].startswith("data:image/png;base64,")
        local_source, _, local_error = _confine_source_images(str(image), None, "probe-session")
        assert local_error is None and local_source == str(image)
        edit_model = next(model for model, info in FAL_MODELS.items() if info.get("edit_endpoint"))
        with patch("tools.image_generation_tool.fal_key_is_configured", return_value=True):
            _, provider_args = _prepare_fal_request(
                edit_model, FAL_MODELS[edit_model], "edit", "square", None, {}, [local_source]
            )
        assert str(image) in json.dumps(provider_args)
        with patch("tools.image_generation_tool.fal_key_is_configured", return_value=True):
            _, uri_provider_args = _prepare_fal_request(
                edit_model, FAL_MODELS[edit_model], "edit", "square", None, {}, [edit_uri]
            )
        assert edit_uri in json.dumps(uri_provider_args)
        uri = "data:image/png;base64,PROBE_PRIVATE_BYTES"
        display_args = redact_tool_args_for_display("image_generate", {"prompt": "edit", "image_url": uri})
        assert uri in json.dumps(display_args)
        observed = [json.loads(line) for line in events.read_text(encoding="utf-8").splitlines()]
        assert [row["event"] for row in observed] == [
            "pre_llm", "pre_tool", "post_tool", "pre_llm", "pre_tool", "post_tool",
            "pre_llm", "pre_tool", "post_tool",
        ], observed
        assert observed[0]["has_manifest"] is True
        assert observed[1]["tool_call_id"] == observed[2]["tool_call_id"] == "call-probe-1"
        assert observed[1]["turn_id"] == observed[2]["turn_id"] == "turn-probe-1"
        print(json.dumps({
            "run": state["status"], "real_agent_run": real_state["status"],
            "idempotent_replay": True, "conflict_status": different.status,
            "history_roles": [row["role"] for row in real_rows], "hook_events": [row["event"] for row in observed],
            "tool_input_origin": resolved.origin, "plugin_route_auth": "401/200/503",
            "local_image_generate_source_unchanged": True, "data_uri_unredacted_in_display_args": True,
            "data_uri_absent_from_success_history_events_logs": True,
            "local_path_provider_adapters": ["openai", "openrouter", "xai"],
        }, ensure_ascii=False))
        db.close()
        adapter._run_idempotency_store.close()


if __name__ == "__main__":
    asyncio.run(main())
