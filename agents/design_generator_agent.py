import json
import random
from datetime import datetime
from typing import Any, Dict, List

from agents.base_agent import BaseAgent

MATERIALS = [
    "Cross-laminated timber (CLT)", "Hempcrete", "Recycled steel",
    "Transparent wood panels", "Self-healing concrete", "Aerogel insulation",
    "Biodegradable composites", "Solar-integrated facades", "Rammed earth",
    "Mycelium-based insulation",
]

STYLES = [
    "Biophilic design", "Parametric architecture", "Modular construction",
    "Net-zero passive house", "Circular economy design", "Adaptive reuse",
    "Vertical green facades", "Scandinavian minimalism", "Industrial loft",
]

TECHNOLOGIES = [
    "BIM Level 3 coordination", "3D-printed structural components",
    "Smart electrochromic glass", "AI-driven climate control",
    "Robotic bricklaying", "IoT energy management", "PV-integrated roofing",
    "Ground-source heat pump", "Thermal mass walls",
]


class DesignGeneratorAgent(BaseAgent):
    """Generates architectural concept designs and future trend predictions."""

    def __init__(self):
        super().__init__("DesignGeneratorAgent")

    # ── Entry point ──────────────────────────────────────────────────────────

    async def execute(self, task: str, data: Dict[str, Any]) -> Dict[str, Any]:
        if task == "generate_concept":
            return await self.generate_concept(data)
        if task == "create_3d_description":
            return await self.create_3d_description(data)
        if task == "design_recommendations":
            return await self.get_recommendations(data)
        if task == "future_trends":
            return await self.future_trends(data)
        return {"error": f"Unknown task: {task}"}

    # ── Concept design ────────────────────────────────────────────────────────

    async def generate_concept(self, data: Dict[str, Any]) -> Dict[str, Any]:
        project_type = data.get("project_type", "residential")
        area = data.get("area", 150)
        location = data.get("location", "Bochum, Germany")
        preferences: List[str] = data.get("preferences", [])
        references = data.get("references", {})

        picked_materials = random.sample(MATERIALS, 3)
        picked_style = random.choice(STYLES)
        picked_tech = random.choice(TECHNOLOGIES)

        system = (
            "You are a senior architect with 20 years of experience in Germany. "
            "Answer only with factual, technically sound content. "
            "Do not invent regulations or costs. Return JSON only."
        )
        prompt = f"""
Create a realistic architectural concept. Return JSON with keys:
  design_philosophy, spatial_organisation, material_palette (list),
  sustainability_features (list), smart_tech_integration (list),
  unique_selling_points (list), potential_challenges (list).

Project:
  type: {project_type}
  area: {area} m²
  location: {location}
  client_preferences: {preferences}
  suggested_materials: {picked_materials}
  style: {picked_style}
  technology: {picked_tech}
  reference_insights: {json.dumps(references, ensure_ascii=False)[:1500]}
"""
        raw_concept = self.call_ollama(prompt, system)
        concept = self.parse_json_response(raw_concept)

        visual_prompt = (
            "Based on this concept, describe a photorealistic exterior rendering. "
            "Return JSON with keys: facade_description, colour_palette (list of hex), "
            "lighting_mood, landscape_notes.\n\n"
            + json.dumps(concept, ensure_ascii=False)[:1000]
        )
        visual = self.parse_json_response(self.call_ollama(visual_prompt))

        return {
            "concept": concept,
            "visual_description": visual,
            "selected_elements": {
                "materials": picked_materials,
                "style": picked_style,
                "technology": picked_tech,
            },
            "generated_at": datetime.utcnow().isoformat(),
        }

    # ── 3-D specification ─────────────────────────────────────────────────────

    async def create_3d_description(self, data: Dict[str, Any]) -> Dict[str, Any]:
        concept = json.dumps(data.get("concept", data), ensure_ascii=False)[:1500]
        style = data.get("style", "modern")

        prompt = (
            "Create a 3D visualisation specification for an architect. "
            "Return JSON with keys: camera_views (list), material_textures (list), "
            "lighting_setup (object), colour_palette (list of hex), "
            "landscape_elements (list), render_engine_notes.\n\n"
            f"Style: {style}\nConcept: {concept}"
        )
        spec = self.parse_json_response(self.call_ollama(prompt))
        return {
            "specification": spec,
            "recommended_software": ["Blender", "Lumion", "Twinmotion", "Unreal Engine 5"],
            "render_settings": {"resolution": "4K", "ray_tracing": True},
        }

    # ── Recommendations ───────────────────────────────────────────────────────

    async def get_recommendations(self, data: Dict[str, Any]) -> Dict[str, Any]:
        project_data = data.get("project_data", {})
        references = data.get("references", {})

        prompt = (
            "You are a construction consultant. "
            "Based on the project data and references below, return JSON with keys: "
            "top_recommendations (list of objects with title+justification), "
            "challenges_and_solutions (list), cost_optimisation (list), "
            "timeline_notes (list).\n\n"
            f"Project data: {json.dumps(project_data, ensure_ascii=False)[:1500]}\n"
            f"References: {json.dumps(references, ensure_ascii=False)[:1500]}"
        )
        result = self.parse_json_response(self.call_ollama(prompt))
        return {"recommendations": result}

    # ── Future trends ─────────────────────────────────────────────────────────

    async def future_trends(self, data: Dict[str, Any]) -> Dict[str, Any]:
        timeframe = data.get("timeframe", "5_years")
        focus_areas: List[str] = data.get("focus_areas", [])

        prompt = (
            "You are a foresight analyst specialising in architecture. "
            "Return JSON with keys: materials_trends (list), design_aesthetics (list), "
            "sustainability_standards (list), smart_integration (list), "
            "urban_planning (list), implementation_timeline (object).\n\n"
            f"Timeframe: {timeframe}\nFocus areas: {focus_areas}"
        )
        trends = self.parse_json_response(self.call_ollama(prompt))
        return {"timeframe": timeframe, "focus_areas": focus_areas, "trends": trends}
