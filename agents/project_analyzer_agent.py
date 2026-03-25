import json
from datetime import datetime
from typing import Any, Dict

from agents.base_agent import BaseAgent


class ProjectAnalyzerAgent(BaseAgent):
    """Analyses construction project requirements, estimates costs and checks compliance."""

    def __init__(self):
        super().__init__("ProjectAnalyzerAgent")

    # ── Entry point ──────────────────────────────────────────────────────────

    async def execute(self, task: str, data: Dict[str, Any]) -> Dict[str, Any]:
        if task == "analyze_requirements":
            return await self.analyse_requirements(data)
        if task == "estimate_costs":
            return await self.estimate_costs(data)
        if task == "check_compliance":
            return await self.check_compliance(data)
        if task == "draft_offer_structure":
            return await self.draft_offer_structure(data)
        if task == "schedule_estimate":
            return await self.schedule_estimate(data)
        return {"error": f"Unknown task: {task}"}

    # ── Requirements analysis ─────────────────────────────────────────────────

    async def analyse_requirements(self, data: Dict[str, Any]) -> Dict[str, Any]:
        description = data.get("description", "")
        requirements = data.get("requirements", [])
        constraints = data.get("constraints", [])

        system = (
            "You are a senior project manager at a German general contractor. "
            "Base answers strictly on the provided input. Do not invent figures. "
            "Return JSON only."
        )
        prompt = (
            "Analyse this construction project and return JSON with keys: "
            "project_type, complexity_score (1-5), key_trades (list), "
            "critical_path_phases (list), dependencies (list), "
            "open_questions (list), recommendations (list).\n\n"
            f"Description: {description}\n"
            f"Requirements: {json.dumps(requirements)}\n"
            f"Constraints: {json.dumps(constraints)}"
        )
        result = self.parse_json_response(self.call_ollama(prompt, system))
        return {"analysis": result, "analysed_at": datetime.utcnow().isoformat()}

    # ── Cost estimation ───────────────────────────────────────────────────────

    async def estimate_costs(self, data: Dict[str, Any]) -> Dict[str, Any]:
        project_data = data.get("project_data", {})
        location = data.get("location", "Bochum, Germany")

        prompt = (
            "Provide a rough preliminary cost estimate for a construction project. "
            "IMPORTANT: all figures are indicative ranges only — not binding. "
            "Return JSON with keys: "
            "cost_breakdown (object with trade names as keys, each with low/high range in EUR), "
            "total_range (object: low, high, currency), "
            "cost_drivers (list), "
            "assumptions (list), "
            "disclaimer.\n\n"
            f"Location: {location}\n"
            f"Project data: {json.dumps(project_data, ensure_ascii=False)[:2000]}"
        )
        result = self.parse_json_response(self.call_ollama(prompt))
        return {"cost_estimate": result}

    # ── Compliance check ──────────────────────────────────────────────────────

    async def check_compliance(self, data: Dict[str, Any]) -> Dict[str, Any]:
        specifications = data.get("specifications", "")
        project_type = data.get("project_type", "residential")

        prompt = (
            "You are a German building compliance advisor. "
            "Review the specifications for potential compliance areas to investigate. "
            "Do NOT state that something is definitely non-compliant — flag items "
            "that need expert verification. "
            "Return JSON with keys: "
            "items_to_verify (list of objects with area+note), "
            "likely_permits_needed (list), "
            "standards_to_check (list), "
            "disclaimer.\n\n"
            f"Project type: {project_type}\n"
            f"Specifications: {specifications[:2500]}"
        )
        result = self.parse_json_response(self.call_ollama(prompt))
        return {"compliance_review": result}

    # ── Offer structure ───────────────────────────────────────────────────────

    async def draft_offer_structure(self, data: Dict[str, Any]) -> Dict[str, Any]:
        project_type = data.get("project_type", "")
        area = data.get("area", "")
        details = data.get("details", "")

        prompt = (
            "Create a professional German-language offer structure (Angebotsgliederung) "
            "for a construction project. "
            "Return JSON with keys: "
            "phases (list of objects: phase_name, description, typical_duration), "
            "payment_milestones (list), "
            "general_conditions_notes (list), "
            "cover_letter_de (short German text ≤120 words).\n\n"
            f"Project type: {project_type}\n"
            f"Area: {area} m²\n"
            f"Details: {details}"
        )
        result = self.parse_json_response(self.call_ollama(prompt))
        return {"offer_structure": result}

    # ── Schedule estimate ─────────────────────────────────────────────────────

    async def schedule_estimate(self, data: Dict[str, Any]) -> Dict[str, Any]:
        project_data = data.get("project_data", {})

        prompt = (
            "Create a realistic construction schedule. "
            "Durations are indicative only. "
            "Return JSON with keys: "
            "phases (list of objects: name, typical_duration_weeks, dependencies, milestones), "
            "total_duration_weeks_range (object: min, max), "
            "risk_factors (list), "
            "assumptions (list).\n\n"
            f"Project data: {json.dumps(project_data, ensure_ascii=False)[:2000]}"
        )
        result = self.parse_json_response(self.call_ollama(prompt))
        return {"schedule": result}
