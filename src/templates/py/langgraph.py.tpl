"""__AGENT_NAME__ — LangGraph Agent on the Zynd network.

pip install zyndai-agent langchain-openai langchain-community langgraph
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from collections import OrderedDict

from dotenv import load_dotenv

from zyndai_agent import AgentConfig, ZyndAIAgent, resolve_registry_url
from zyndai_agent.a2a.server import HandlerInput, TaskHandle

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langchain_community.tools.tavily_search import TavilySearchResults
from langgraph.graph import StateGraph, MessagesState, START, END
from langgraph.prebuilt import ToolNode, tools_condition

from payload import RequestPayload, ResponsePayload, MAX_FILE_SIZE_BYTES

load_dotenv()

_config: dict = {}
if os.path.exists("agent.config.json"):
    with open("agent.config.json") as _f:
        _config = json.load(_f)


def build_langgraph_agent():
    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
    tools = [TavilySearchResults(max_results=3)]
    llm_with_tools = llm.bind_tools(tools)

    def agent_node(state: MessagesState):
        system = SystemMessage(content="You are __AGENT_NAME__, a helpful AI assistant. Use the search tool when you don't know something.")
        return {"messages": [llm_with_tools.invoke([system] + state["messages"])]}

    graph = StateGraph(MessagesState)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", ToolNode(tools))
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", tools_condition)
    graph.add_edge("tools", "agent")
    return graph.compile()


CTX_HISTORY_TURNS = 10
CTX_IDLE_SECONDS = 60 * 60


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


if __name__ == "__main__":
    agent_config = AgentConfig(
        name=_config.get("name", "__AGENT_NAME__"),
        description=_config.get("description", "__AGENT_NAME__ — a LangGraph agent on the Zynd network."),
        version=_config.get("version", "0.1.0"),
        category=_config.get("category", "general"),
        tags=_config.get("tags", ["langgraph"]),
        server_host=_config.get("server_host", "0.0.0.0"),
        server_port=int(os.environ.get("ZYND_SERVER_PORT") or _config.get("server_port") or _config.get("webhook_port") or 5000),
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

    graph = build_langgraph_agent()
    zynd_agent.set_langgraph_agent(graph)

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
            result = graph.invoke({"messages": history + [HumanMessage(content=inbound.message.content)]})
            messages = result.get("messages") if isinstance(result, dict) else None
            response = getattr(messages[-1], "content", str(messages[-1])) if messages else str(result)
            conversations.append(ctx_id, inbound.message.content, response)
            return {"response": response}
        except Exception as e:
            return task.fail(str(e))

    zynd_agent.on_message(handle)
    zynd_agent.start()

    print(f"\n__AGENT_NAME__ is running (LangGraph)")
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
