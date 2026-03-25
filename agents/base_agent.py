import json
import os
import requests
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Dict


class BaseAgent(ABC):
    """Abstract base class for all AI agents."""

    def __init__(self, name: str):
        self.name = name
        self.ollama_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
        self.model = os.getenv("OLLAMA_MODEL", "llama3.1:8b")
        self.timeout = int(os.getenv("AGENT_TIMEOUT", "120"))

    @abstractmethod
    async def execute(self, task: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Execute agent task — must be overridden."""

    def call_ollama(self, prompt: str, system_prompt: str = "") -> str:
        """Synchronous Ollama call with structured prompt."""
        full_prompt = f"{system_prompt}\n\n{prompt}".strip() if system_prompt else prompt
        try:
            response = requests.post(
                f"{self.ollama_url}/api/generate",
                json={
                    "model": self.model,
                    "prompt": full_prompt,
                    "stream": False,
                    "format": "json",
                    "options": {
                        "temperature": 0.3,
                        "top_p": 0.9,
                        "num_predict": 2000,
                    },
                },
                timeout=self.timeout,
            )
            response.raise_for_status()
            return response.json().get("response", "")
        except Exception as exc:
            self.log("ollama_error", {"error": str(exc)})
            return ""

    def parse_json_response(self, raw: str) -> Any:
        """Try to parse JSON from Ollama response; fall back to raw string."""
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            import re
            match = re.search(r"\{[\s\S]*\}", raw)
            if match:
                try:
                    return json.loads(match.group())
                except json.JSONDecodeError:
                    pass
        return {"raw": raw}

    def log(self, action: str, details: Dict) -> None:
        """Append structured log entry to agent_logs.ndjson."""
        entry = {
            "agent": self.name,
            "action": action,
            "details": details,
            "ts": datetime.utcnow().isoformat(),
        }
        log_path = os.path.join(os.path.dirname(__file__), "..", "agent_logs.ndjson")
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
