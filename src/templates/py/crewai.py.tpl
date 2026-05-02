"""__AGENT_NAME__ — CrewAI Agent on the Zynd network.

pip install zyndai-agent crewai crewai-tools
"""

from __future__ import annotations

import json
import os
import sys

from dotenv import load_dotenv

from zyndai_agent import AgentConfig, ZyndAIAgent, resolve_registry_url
from zyndai_agent.a2a.server import HandlerInput, TaskHandle

from payload import RequestPayload, ResponsePayload, MAX_FILE_SIZE_BYTES

load_dotenv()

_config: dict = {}
if os.path.exists("agent.config.json"):
    with open("agent.config.json") as _f:
        _config = json.load(_f)


def build_crew():
    from crewai import Agent, Task, Crew, Process
    from crewai_tools import SerperDevTool

    search_tool = SerperDevTool()

    researcher = Agent(
        role="Researcher",
        goal="Research and gather comprehensive data",
        backstory="You are an expert researcher who excels at finding relevant information.",
        tools=[search_tool],
        verbose=False,
    )
    analyst = Agent(
        role="Analyst",
        goal="Analyze data and provide insights",
        backstory="You are a senior analyst who provides balanced, professional analysis.",
        verbose=False,
    )
    research_task = Task(
        description="Research the topic: {query}. Gather key data and facts.",
        expected_output="Comprehensive research data",
        agent=researcher,
    )
    analysis_task = Task(
        description="Analyze the research and provide insights on: {query}",
        expected_output="Professional analysis with key takeaways",
        agent=analyst,
    )
    return Crew(
        agents=[researcher, analyst],
        tasks=[research_task, analysis_task],
        process=Process.sequential,
        verbose=False,
    )


if __name__ == "__main__":
    agent_config = AgentConfig(
        name=_config.get("name", "__AGENT_NAME__"),
        description=_config.get("description", "__AGENT_NAME__ — a CrewAI multi-agent system on the Zynd network."),
        version=_config.get("version", "0.1.0"),
        category=_config.get("category", "general"),
        tags=_config.get("tags", ["crewai", "multi-agent"]),
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

    zynd_agent.set_crewai_agent(build_crew())

    def handle(inbound: HandlerInput, task: TaskHandle):
        try:
            return {"response": zynd_agent.invoke(inbound.message.content)}
        except Exception as e:
            return task.fail(str(e))

    zynd_agent.on_message(handle)
    zynd_agent.start()

    print(f"\n__AGENT_NAME__ is running (CrewAI)")
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
