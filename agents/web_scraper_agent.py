import asyncio
import importlib
import json
from typing import Any, Dict, List
from urllib.parse import urljoin

import aiohttp
from bs4 import BeautifulSoup

from agents.base_agent import BaseAgent

trafilatura: Any = None
try:
    trafilatura = importlib.import_module("trafilatura")
except Exception:
    trafilatura = None

CONSTRUCTION_KEYWORDS = [
    "construction", "architecture", "building", "design", "renovation",
    "haus", "bau", "architektur", "projekt", "facade", "interior",
]

REFERENCE_URLS = {
    "archdaily": "https://www.archdaily.com/search/projects/q/{q}",
    "dezeen": "https://www.dezeen.com/?s={q}",
    "detail": "https://www.detail.de/suche/?q={q}",
}


class WebScraperAgent(BaseAgent):
    """Scrapes and AI-analyses web pages for construction references."""

    def __init__(self):
        super().__init__("WebScraperAgent")
        self.visited: set = set()

    # ── Entry point ──────────────────────────────────────────────────────────

    async def execute(self, task: str, data: Dict[str, Any]) -> Dict[str, Any]:
        if task == "scrape_links":
            urls = data.get("urls", [])
            depth = min(int(data.get("depth", 1)), 3)
            return await self.scrape_multiple(urls, depth)
        if task == "search_references":
            return await self.search_references(data.get("query", ""))
        if task == "extract_project_info":
            return await self.extract_project(data.get("url", ""))
        return {"error": f"Unknown task: {task}"}

    # ── Core scraping ─────────────────────────────────────────────────────────

    async def scrape_multiple(self, urls: List[str], depth: int) -> Dict[str, Any]:
        results = {}
        async with aiohttp.ClientSession(
            headers={"User-Agent": "Mozilla/5.0 (compatible; ABA-Agent/1.0)"},
            connector=aiohttp.TCPConnector(ssl=False),
        ) as session:
            tasks = [self._scrape(session, url, depth) for url in urls]
            scraped = await asyncio.gather(*tasks, return_exceptions=True)
        for url, result in zip(urls, scraped):
            results[url] = result if not isinstance(result, Exception) else {"error": str(result)}
        return {"scraped": results, "count": len(results)}

    async def _scrape(self, session: aiohttp.ClientSession, url: str, depth: int) -> Dict[str, Any]:
        if depth <= 0 or url in self.visited:
            return {}
        self.visited.add(url)
        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                html = await resp.text(errors="replace")
        except Exception as exc:
            return {"error": str(exc)}

        if trafilatura:
            text = trafilatura.extract(html) or ""
        else:
            text = BeautifulSoup(html, "html.parser").get_text(" ", strip=True)
        soup = BeautifulSoup(html, "html.parser")

        images: List[str] = []
        for img in soup.find_all("img", src=True):
            src_raw = img.get("src")
            src = src_raw if isinstance(src_raw, str) else ""
            if src.startswith(("http", "/")):
                images.append(urljoin(url, src))
            if len(images) >= 8:
                break

        title = ""
        if soup.title and isinstance(soup.title.string, str):
            title = soup.title.string.strip()

        meta_description = ""
        meta_tag = soup.find("meta", {"name": "description"})
        if meta_tag:
            description_raw = meta_tag.get("content")
            if isinstance(description_raw, str):
                meta_description = description_raw

        meta = {
            "title": title,
            "description": meta_description,
        }

        analysis = self._analyse_text(text[:3000]) if text else {}

        sub_links: List[str] = []
        if depth > 1:
            for a in soup.find_all("a", href=True):
                href_raw = a.get("href")
                href = href_raw if isinstance(href_raw, str) else ""
                if not href:
                    continue
                candidate = urljoin(url, href)
                if self._is_relevant(candidate) and candidate not in self.visited:
                    sub_links.append(candidate)
            sub_links = sub_links[:4]

        child_results = {}
        if sub_links:
            async with aiohttp.ClientSession(
                headers={"User-Agent": "Mozilla/5.0"},
                connector=aiohttp.TCPConnector(ssl=False),
            ) as child_session:
                child_tasks = [self._scrape(child_session, u, depth - 1) for u in sub_links]
                children = await asyncio.gather(*child_tasks, return_exceptions=True)
            for link, child in zip(sub_links, children):
                child_results[link] = child if not isinstance(child, Exception) else {}

        return {
            "url": url,
            "meta": meta,
            "text_preview": text[:1500],
            "images": images,
            "analysis": analysis,
            "children": child_results,
        }

    def _analyse_text(self, text: str) -> Dict[str, Any]:
        if not text.strip():
            return {}
        prompt = (
            "You are a construction research assistant. "
            "Analyse this content and return JSON with keys: "
            "topics (list), materials (list), design_trends (list), key_numbers (list). "
            "Only include items actually mentioned. Be concise.\n\nContent:\n" + text
        )
        raw = self.call_ollama(prompt)
        return self.parse_json_response(raw)

    # ── Reference search ──────────────────────────────────────────────────────

    async def search_references(self, query: str) -> Dict[str, Any]:
        urls = [tpl.format(q=query.replace(" ", "+")) for tpl in REFERENCE_URLS.values()]
        scraped = await self.scrape_multiple(urls, depth=1)

        summary_prompt = (
            "You are an expert construction researcher. "
            "Summarise the following scraped reference data into a JSON with keys: "
            "best_practices (list), innovative_designs (list), materials (list), "
            "cost_notes (list), recommended_links (list). "
            "Only use information present in the data.\n\n"
            + json.dumps(scraped, ensure_ascii=False)[:4000]
        )
        raw = self.call_ollama(summary_prompt)
        return {
            "query": query,
            "scraped": scraped,
            "ai_summary": self.parse_json_response(raw),
        }

    # ── Single project extraction ─────────────────────────────────────────────

    async def extract_project(self, url: str) -> Dict[str, Any]:
        async with aiohttp.ClientSession(
            headers={"User-Agent": "Mozilla/5.0"},
            connector=aiohttp.TCPConnector(ssl=False),
        ) as session:
            data = await self._scrape(session, url, 1)

        if data.get("text_preview"):
            prompt = (
                "Extract structured project data from this text and return JSON with keys: "
                "project_type, area_sqm, duration, materials, special_features, budget_range. "
                "Use null for unknown fields.\n\n" + data["text_preview"]
            )
            raw = self.call_ollama(prompt)
            data["extracted"] = self.parse_json_response(raw)
        return data

    # ── Helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _is_relevant(url: str) -> bool:
        lower = url.lower()
        return any(kw in lower for kw in CONSTRUCTION_KEYWORDS)
