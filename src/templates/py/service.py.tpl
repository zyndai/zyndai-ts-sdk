"""__SERVICE_NAME__ — Service on the Zynd network."""

from zyndai_agent import ServiceConfig, ZyndService, resolve_registry_url
from zyndai_agent.a2a.server import HandlerInput, TaskHandle

from payload import RequestPayload, ResponsePayload, MAX_FILE_SIZE_BYTES

from dotenv import load_dotenv
import json
import os
import sys

load_dotenv()

_config = {}
if os.path.exists("service.config.json"):
    with open("service.config.json") as _f:
        _config = json.load(_f)


if __name__ == "__main__":
    config = ServiceConfig(
        name=_config.get("name", "__SERVICE_NAME__"),
        description=_config.get("description", ""),
        version=_config.get("version", "0.1.0"),
        category=_config.get("category", "general"),
        tags=_config.get("tags", []),
        service_endpoint=_config.get("service_endpoint"),
        openapi_url=_config.get("openapi_url"),
        server_host=_config.get("server_host", "0.0.0.0"),
        server_port=int(os.environ.get("ZYND_SERVER_PORT") or _config.get("server_port") or _config.get("webhook_port") or 5000),
        auth_mode=_config.get("auth_mode", "permissive"),
        registry_url=resolve_registry_url(from_config_file=_config.get("registry_url")),
        keypair_path=os.environ.get("ZYND_SERVICE_KEYPAIR_PATH", _config.get("keypair_path")),
        entity_url=os.environ.get("ZYND_ENTITY_URL", _config.get("entity_url")),
        price=_config.get("price"),
        entity_pricing=_config.get("entity_pricing"),
        entity_index=_config.get("entity_index", 0),
        skills=_config.get("skills"),
        fqan=_config.get("fqan"),
    )

    service = ZyndService(
        config=config,
        payload_model=RequestPayload,
        output_model=ResponsePayload,
        max_body_bytes=MAX_FILE_SIZE_BYTES,
    )

    def handle(inbound: HandlerInput, task: TaskHandle):
        return {"response": f"Hello from __SERVICE_NAME__! You sent: {inbound.message.content}"}

    service.on_message(handle)
    service.start()

    print(f"\n__SERVICE_NAME__ is running")
    print(f"A2A endpoint: {service.a2a_url}")
    print(f"Agent card:   {service.card_url}")

    if sys.stdin.isatty():
        print("Type 'exit' to quit\n")
        while True:
            try:
                cmd = input()
            except EOFError:
                break
            if cmd.lower() == "exit":
                break
        service.stop()
    else:
        import signal
        signal.pause()
