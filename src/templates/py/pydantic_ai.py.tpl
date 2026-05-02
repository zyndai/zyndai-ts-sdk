"""
__AGENT_NAME__ — PydanticAI Agent on the Zynd network (A2A protocol).

Install dependencies:
    pip install zyndai-agent pydantic-ai

Run:
    python agent.py
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from collections import OrderedDict

from dotenv import load_dotenv

from zyndai_agent import (
    AgentConfig,
    ZyndAIAgent,
    resolve_registry_url,
)
from zyndai_agent.a2a.server import HandlerInput, TaskHandle

from payload import RequestPayload, ResponsePayload, MAX_FILE_SIZE_BYTES

load_dotenv()

# Load agent.config.json for runtime settings
_config: dict = {}
if os.path.exists("agent.config.json"):
    with open("agent.config.json") as _f:
        _config = json.load(_f)


def build_pydantic_ai_agent():
    from pydantic_ai import Agent, RunContext
    from pydantic_ai.models.openai import OpenAIModel

    model = OpenAIModel("gpt-4o-mini")

    agent = Agent(
        model,
        system_prompt=(
            "You are __AGENT_NAME__, a helpful AI assistant. Use the search "
            "tool when you don't know something — do not say 'I don't know'."
        ),
        result_type=str,
    )

    @agent.tool
    async def search(ctx: RunContext[None], query: str) -> str:
        """Search for information. Replace with your own tools."""
        return f"Search results for '{query}': Demo data — integrate with real APIs."

    return agent


# ----------------------------------------------------------------------------
# Per-conversation memory (keyed on contextId — see langchain.py for rationale)
# ----------------------------------------------------------------------------

CTX_HISTORY_TURNS = 10
CTX_IDLE_SECONDS = 60 * 60


class ConversationStore:
    """Stores PydanticAI message history per A2A contextId.

    PydanticAI's `Agent.run_sync(prompt, message_history=...)` accepts a
    list of ModelMessage instances; we round-trip those between calls.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._convos: OrderedDict[str, list] = OrderedDict()
        self._last_seen: dict[str, float] = {}

    def get(self, ctx_id: str) -> list:
        with self._lock:
            return list(self._convos.get(ctx_id) or [])

    def set(self, ctx_id: str, messages: list) -> None:
        with self._lock:
            cap = CTX_HISTORY_TURNS * 2
            if len(messages) > cap:
                messages = messages[-cap:]
            self._convos[ctx_id] = messages
            self._last_seen[ctx_id] = time.time()

    def gc(self) -> None:
        cutoff = time.time() - CTX_IDLE_SECONDS
        with self._lock:
            stale = [c for c, ts in self._last_seen.items() if ts < cutoff]
            for c in stale:
                self._convos.pop(c, None)
                self._last_seen.pop(c, None)


if __name__ == "__main__":
    agent_config = AgentConfig(
        name=_config.get("name", "__AGENT_NAME__"),
        description=_config.get(
            "description",
            "__AGENT_NAME__ — a PydanticAI agent on the Zynd network.",
        ),
        version=_config.get("version", "0.1.0"),
        category=_config.get("category", "general"),
        tags=_config.get("tags", ["pydantic-ai"]),
        server_host=_config.get("server_host", "0.0.0.0"),
        server_port=int(os.environ.get("ZYND_SERVER_PORT", _config.get("server_port", 5000))),
        auth_mode=_config.get("auth_mode", "permissive"),
        registry_url=resolve_registry_url(from_config_file=_config.get("registry_url")),
        keypair_path=os.environ.get("ZYND_AGENT_KEYPAIR_PATH", _config.get("keypair_path")),
        entity_url=os.environ.get("ZYND_ENTITY_URL", _config.get("entity_url")),
        price=_config.get("price"),
        entity_pricing=_config.get("entity_pricing"),
        entity_index=_config.get("entity_index", 0),
        skills=_config.get("skills"),
        fqan=_config.get("fqan"),
    )

    zynd_agent = ZyndAIAgent(
        config=agent_config,
        payload_model=RequestPayload,
        output_model=ResponsePayload,
        max_body_bytes=MAX_FILE_SIZE_BYTES,
    )

    pydantic_agent = build_pydantic_ai_agent()
    zynd_agent.set_pydantic_ai_agent(pydantic_agent)

    conversations = ConversationStore()

    def _gc_loop() -> None:
        while True:
            time.sleep(5 * 60)
            try:
                conversations.gc()
            except Exception:
                pass

    threading.Thread(target=_gc_loop, daemon=True).start()

    def handle(inbound: HandlerInput, task: TaskHandle):
        ctx_id = task.context_id
        history = conversations.get(ctx_id)
        try:
            result = pydantic_agent.run_sync(
                inbound.message.content,
                message_history=history,
            )
            response = str(getattr(result, "data", result))
            # PydanticAI's result exposes the full message history including
            # the new exchange via .all_messages().
            new_history = (
                result.all_messages()
                if hasattr(result, "all_messages")
                else history
            )
            conversations.set(ctx_id, new_history)
            return {"response": response}
        except Exception as e:
            return task.fail(str(e))

    zynd_agent.on_message(handle)
    zynd_agent.start()

    print(f"\n__AGENT_NAME__ is running (PydanticAI, A2A)")
    print(f"A2A endpoint: {zynd_agent.a2a_url}")
    print(f"Agent card:   {zynd_agent.card_url}")

    if sys.stdin.isatty():
        print("Type 'exit' to quit\n")
        while True:
            try:
                cmd = input()
            except EOFError:
                break
            if cmd.lower() == "exit":
                break
        zynd_agent.stop()
    else:
        import signal
        signal.pause()
