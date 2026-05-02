"""
__AGENT_NAME__ — LangChain Agent on the Zynd network (A2A protocol).

Install dependencies:
    pip install zyndai-agent langchain langchain-openai langchain-community langchain-classic

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
    A2AClient,
    SearchAndDiscoveryManager,
    ZyndAIAgent,
    resolve_registry_url,
)
from zyndai_agent.a2a.server import HandlerInput, TaskHandle

from langchain_openai import ChatOpenAI
from langchain_classic.agents import AgentExecutor, create_tool_calling_agent
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.tools import tool
from langchain_community.tools.tavily_search import TavilySearchResults

from payload import RequestPayload, ResponsePayload, MAX_FILE_SIZE_BYTES

load_dotenv()

# Load agent.config.json for runtime settings
_config: dict = {}
if os.path.exists("agent.config.json"):
    with open("agent.config.json") as _f:
        _config = json.load(_f)


# ----------------------------------------------------------------------------
# LangChain agent (LLM + tools)
# ----------------------------------------------------------------------------


def build_langchain_agent(zynd_agent: ZyndAIAgent, registry_url: str) -> AgentExecutor:
    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

    # SDK clients reused by the tools below.
    search = SearchAndDiscoveryManager(registry_url)
    a2a_client = A2AClient(
        keypair=zynd_agent.keypair,
        entity_id=zynd_agent.entity_id,
        fqan=_config.get("fqan"),
    )

    # Demo tools. Replace these with your real ones.

    @tool
    def hello(query: str) -> str:
        """A simple demo tool. Replace with your own."""
        return f"Hello! You asked: {query}"

    @tool
    def search_agents(query: str, limit: int = 5) -> str:
        """Search the Zynd registry for other agents by keyword. Returns
        name, summary, entity_url (when available), and fqan for each match."""
        results = search.search_agents_by_keyword(query, limit) or []
        return json.dumps(
            [
                {
                    "entity_id": r.get("entity_id"),
                    "name": r.get("name"),
                    "summary": r.get("summary"),
                    "entity_url": r.get("entity_url"),
                    "fqan": r.get("fqan"),
                    "tags": r.get("tags"),
                }
                for r in results
            ],
            indent=2,
        )

    @tool
    def call_agent(entity_url: str, message: str) -> str:
        """Send an A2A message to another agent.

        Pass the agent's card URL (ending in /.well-known/agent-card.json),
        its base URL (e.g. http://localhost:5000), or its A2A endpoint URL
        (e.g. http://localhost:5000/a2a/v1). Returns the agent's reply text.
        """
        # client.ask() does the right thing: fetches the agent card if
        # needed, sends a signed A2A message, reads the reply from
        # task.artifacts (NOT task.history — that contains your own
        # outbound message echoed back, which causes the LLM to loop).
        return a2a_client.ask(entity_url, message)

    tools = [hello, TavilySearchResults(max_results=3), search_agents, call_agent]

    prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                "You are __AGENT_NAME__, a helpful AI assistant. "
                "Use `search_agents` to discover other agents on the Zynd "
                "network and `call_agent` to talk to them over A2A. Use "
                "`tavily_search_results_json` when you don't know something — "
                "do not say 'I don't know'.",
            ),
            MessagesPlaceholder(variable_name="chat_history"),
            ("human", "{input}"),
            MessagesPlaceholder(variable_name="agent_scratchpad"),
        ]
    )

    agent = create_tool_calling_agent(llm, tools, prompt)
    return AgentExecutor(
        agent=agent,
        tools=tools,
        verbose=False,
        # Hard ceiling on tool-call iterations per invocation. Without this
        # a chatty LLM can drain your model quota chaining call_agent →
        # search → call_agent → ... until LangChain's default cap (15).
        max_iterations=3,
    )


# ----------------------------------------------------------------------------
# Per-conversation memory (keyed on contextId)
# ----------------------------------------------------------------------------
#
# Keyed on A2A's `contextId` (NOT senderEntityId or taskId):
#   - One sender can run multiple parallel conversations with us; each
#     contextId is its own conversation, so each gets its own history.
#   - One conversation can spawn multiple tasks (e.g. an input-required
#     loopback creates a new taskId in the same context); they share
#     history because they share contextId.
#   - Idle conversations are GC'd after CTX_IDLE_SECONDS so abandoned
#     contextIds don't leak memory. For multi-replica deployments push
#     this dict into Redis keyed on contextId.

CTX_HISTORY_TURNS = 10
CTX_IDLE_SECONDS = 60 * 60  # 1h


class ConversationStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._convos: OrderedDict[str, list[BaseMessage]] = OrderedDict()
        self._last_seen: dict[str, float] = {}

    def get(self, ctx_id: str) -> list[BaseMessage]:
        with self._lock:
            return list(self._convos.get(ctx_id) or [])

    def append(self, ctx_id: str, human: str, ai: str) -> None:
        with self._lock:
            history = self._convos.get(ctx_id) or []
            history.append(HumanMessage(content=human))
            history.append(AIMessage(content=ai))
            cap = CTX_HISTORY_TURNS * 2
            if len(history) > cap:
                history = history[-cap:]
            self._convos[ctx_id] = history
            self._last_seen[ctx_id] = time.time()

    def gc(self) -> None:
        cutoff = time.time() - CTX_IDLE_SECONDS
        with self._lock:
            stale = [c for c, ts in self._last_seen.items() if ts < cutoff]
            for c in stale:
                self._convos.pop(c, None)
                self._last_seen.pop(c, None)


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------


if __name__ == "__main__":
    agent_config = AgentConfig(
        name=_config.get("name", "__AGENT_NAME__"),
        description=_config.get(
            "description",
            "__AGENT_NAME__ — a LangChain agent on the Zynd network.",
        ),
        version=_config.get("version", "0.1.0"),
        category=_config.get("category", "general"),
        tags=_config.get("tags", ["langchain"]),
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

    executor = build_langchain_agent(zynd_agent, agent_config.registry_url)
    zynd_agent.set_langchain_agent(executor)

    conversations = ConversationStore()

    # Periodic GC for idle conversations.
    def _gc_loop() -> None:
        while True:
            time.sleep(5 * 60)
            try:
                conversations.gc()
            except Exception:
                pass

    threading.Thread(target=_gc_loop, daemon=True).start()

    # A2A inbound — other agents talk to us through this handler.
    # Auth (signature, replay, expiry) is verified by the SDK BEFORE this
    # fires; if you want to see those rejections, watch the server's stdout
    # for "[a2a-server] dispatch threw:" lines or inspect HTTP responses.
    def handle(inbound: HandlerInput, task: TaskHandle):
        ctx_id = task.context_id
        history = conversations.get(ctx_id)
        try:
            response = zynd_agent.invoke(
                inbound.message.content,
                chat_history=history,
            )
            conversations.append(ctx_id, inbound.message.content, response)
            # Return the response — SDK auto-calls task.complete() with this
            # value. The output is validated against ResponsePayload before
            # shipping.
            return {"response": response}
        except Exception as e:
            return task.fail(str(e))

    zynd_agent.on_message(handle)
    zynd_agent.start()

    print(f"\n__AGENT_NAME__ is running (LangChain, A2A)")
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
