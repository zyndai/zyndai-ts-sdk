"""__AGENT_NAME__ — Custom Agent on the Zynd network."""

from zyndai_agent import AgentConfig, ZyndAIAgent, resolve_registry_url
from zyndai_agent.a2a.server import HandlerInput, TaskHandle

from payload import RequestPayload, ResponsePayload, MAX_FILE_SIZE_BYTES

from dotenv import load_dotenv
import json
import os
import sys

load_dotenv()

_config = {}
if os.path.exists("agent.config.json"):
    with open("agent.config.json") as _f:
        _config = json.load(_f)


if __name__ == "__main__":
    agent_config = AgentConfig(
        name=_config.get("name", "__AGENT_NAME__"),
        description=_config.get("description", "__AGENT_NAME__ — a custom agent on the Zynd network."),
        version=_config.get("version", "0.1.0"),
        category=_config.get("category", "general"),
        tags=_config.get("tags", []),
        server_host=_config.get("server_host", "0.0.0.0"),
        server_port=int(os.environ.get("ZYND_SERVER_PORT") or _config.get("server_port") or _config.get("webhook_port") or 5000),
        auth_mode=_config.get("auth_mode", "permissive"),
        registry_url=resolve_registry_url(from_config_file=_config.get("registry_url")),
        keypair_path=os.environ.get("ZYND_AGENT_KEYPAIR_PATH", _config.get("keypair_path")),
        entity_url=os.environ.get("ZYND_ENTITY_URL", _config.get("entity_url")),
        price=_config.get("price"),
        entity_pricing=_config.get("entity_pricing"),
        entity_index=_config.get("entity_index", 0),
    )

    agent = ZyndAIAgent(
        config=agent_config,
        payload_model=RequestPayload,
        output_model=ResponsePayload,
        max_body_bytes=MAX_FILE_SIZE_BYTES,
    )

    def handle(inbound: HandlerInput, task: TaskHandle):
        return {"response": f"Hello from __AGENT_NAME__! You asked: {inbound.message.content}"}

    agent.on_message(handle)
    agent.start()

    print(f"\n__AGENT_NAME__ is running")
    print(f"A2A endpoint: {agent.a2a_url}")
    print(f"Agent card:   {agent.card_url}")

    if sys.stdin.isatty():
        print("Type 'exit' to quit\n")
        while True:
            try:
                cmd = input()
            except EOFError:
                break
            if cmd.lower() == "exit":
                break
        agent.stop()
    else:
        import signal
        signal.pause()
