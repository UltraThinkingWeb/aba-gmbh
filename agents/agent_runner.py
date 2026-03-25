#!/usr/bin/env python3
"""
agent_runner.py — Node.js/Python bridge.

Usage (called by server.js via child_process):
  python3 agent_runner.py '<json>'

JSON schema:
    { "agent": "WebScraperAgent|DesignGeneratorAgent|ProjectAnalyzerAgent|SeoAgent",
    "task":  "<task_name>",
    "data":  { ... } }

Stdout: single JSON line with result or {"error": "..."}.
"""

import asyncio
import json
import sys
import traceback
from typing import Any

from agents.design_generator_agent import DesignGeneratorAgent
from agents.project_analyzer_agent import ProjectAnalyzerAgent
from agents.seo_agent import SeoAgent
from agents.web_scraper_agent import WebScraperAgent

AGENTS = {
    "WebScraperAgent": WebScraperAgent,
    "DesignGeneratorAgent": DesignGeneratorAgent,
    "ProjectAnalyzerAgent": ProjectAnalyzerAgent,
    "SeoAgent": SeoAgent,
}


async def run(agent_name: str, task: str, data: dict) -> dict:
    agent: Any
    if agent_name == "WebScraperAgent":
        agent = WebScraperAgent()
    elif agent_name == "DesignGeneratorAgent":
        agent = DesignGeneratorAgent()
    elif agent_name == "ProjectAnalyzerAgent":
        agent = ProjectAnalyzerAgent()
    elif agent_name == "SeoAgent":
        agent = SeoAgent()
    else:
        return {"error": f"Unknown agent: {agent_name}. Available: {list(AGENTS)}"}
    return await agent.execute(task, data)


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No input JSON argument provided"}))
        sys.exit(1)

    try:
        payload = json.loads(sys.argv[1])
    except json.JSONDecodeError as exc:
        print(json.dumps({"error": f"Invalid JSON input: {exc}"}))
        sys.exit(1)

    agent_name = str(payload.get("agent", ""))
    task = str(payload.get("task", ""))
    data = payload.get("data", {})

    if not agent_name or not task:
        print(json.dumps({"error": "'agent' and 'task' are required"}))
        sys.exit(1)

    try:
        result = asyncio.run(run(agent_name, task, data))
        print(json.dumps(result, ensure_ascii=False, default=str))
    except Exception:
        err = traceback.format_exc()
        print(json.dumps({"error": err}))
        sys.exit(1)


if __name__ == "__main__":
    main()
