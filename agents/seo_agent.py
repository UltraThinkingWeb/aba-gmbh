import asyncio
import json
import re
from datetime import datetime
from typing import Any, Dict, List
from urllib.parse import urlparse

import aiohttp
from bs4 import BeautifulSoup

from agents.base_agent import BaseAgent


class SeoAgent(BaseAgent):
    """Scalable SEO agent for multi-page audits and executive summaries."""

    def __init__(self):
        super().__init__("SeoAgent")
        self.max_urls = int(__import__("os").getenv("SEO_MAX_URLS", "20"))
        self.concurrency = int(__import__("os").getenv("SEO_CONCURRENCY", "5"))

    async def execute(self, task: str, data: Dict[str, Any]) -> Dict[str, Any]:
        if task == "seo_audit":
            return await self.seo_audit(data)
        if task == "keyword_map":
            return await self.keyword_map(data)
        if task == "ceo_brief":
            return await self.ceo_brief(data)
        return {"error": f"Unknown task: {task}"}

    async def seo_audit(self, data: Dict[str, Any]) -> Dict[str, Any]:
        urls = data.get("urls", [])
        if isinstance(urls, str):
            urls = [urls]

        urls = [u for u in urls if isinstance(u, str) and u.startswith(("http://", "https://"))]
        urls = urls[: self.max_urls]

        if not urls:
            return {"error": "urls required"}

        semaphore = asyncio.Semaphore(max(1, self.concurrency))
        timeout = aiohttp.ClientTimeout(total=min(self.timeout, 60))
        headers = {"User-Agent": "Mozilla/5.0 (compatible; ABA-SEO-Agent/1.0)"}

        async with aiohttp.ClientSession(timeout=timeout, headers=headers, connector=aiohttp.TCPConnector(ssl=False)) as session:
            tasks = [self._audit_one(session, semaphore, url) for url in urls]
            results = await asyncio.gather(*tasks, return_exceptions=True)

        pages: Dict[str, Any] = {}
        for url, result in zip(urls, results):
            if isinstance(result, Exception):
                pages[url] = {"error": str(result)}
            else:
                pages[url] = result

        summary = self._build_summary(pages)
        return {
            "task": "seo_audit",
            "checked_urls": len(urls),
            "summary": summary,
            "pages": pages,
            "generated_at": datetime.utcnow().isoformat(),
        }

    async def keyword_map(self, data: Dict[str, Any]) -> Dict[str, Any]:
        audit = await self.seo_audit(data)
        if audit.get("error"):
            return audit

        raw_text = json.dumps(audit.get("pages", {}), ensure_ascii=False)[:9000]
        prompt = (
            "You are an SEO strategist for a construction company in Germany. "
            "Return strict JSON with keys: primary_keywords (list), secondary_keywords (list), "
            "location_keywords (list), content_gaps (list), page_actions (list of objects with page+action).\n\n"
            f"Audit data:\n{raw_text}"
        )
        mapped = self.parse_json_response(self.call_ollama(prompt))
        return {
            "task": "keyword_map",
            "audit_summary": audit.get("summary", {}),
            "keyword_strategy": mapped,
        }

    async def ceo_brief(self, data: Dict[str, Any]) -> Dict[str, Any]:
        source = data.get("audit")
        if not source:
            source = await self.seo_audit(data)
        if source.get("error"):
            return source

        prompt = (
            "Create a CEO-level SEO brief in strict JSON with keys: "
            "status (green|yellow|red), top_5_risks (list), top_5_opportunities (list), "
            "next_30_days (list), expected_business_impact (list). "
            "Use concise executive language.\n\n"
            + json.dumps(source.get("summary", {}), ensure_ascii=False)[:4000]
        )
        brief = self.parse_json_response(self.call_ollama(prompt))
        return {
            "task": "ceo_brief",
            "ceo_summary": brief,
            "generated_at": datetime.utcnow().isoformat(),
        }

    async def _audit_one(self, session: aiohttp.ClientSession, semaphore: asyncio.Semaphore, url: str) -> Dict[str, Any]:
        async with semaphore:
            try:
                async with session.get(url) as response:
                    status = response.status
                    html = await response.text(errors="replace")
            except Exception as exc:
                return {"error": str(exc)}

            soup = BeautifulSoup(html, "html.parser")
            title = (soup.title.string or "").strip() if soup.title and soup.title.string else ""
            meta_desc_tag = soup.find("meta", attrs={"name": re.compile("^description$", re.I)})
            canonical_tag = soup.find("link", attrs={"rel": re.compile("canonical", re.I)})
            robots_tag = soup.find("meta", attrs={"name": re.compile("^robots$", re.I)})
            h1_tags = [h.get_text(" ", strip=True) for h in soup.find_all("h1")]
            h2_count = len(soup.find_all("h2"))
            images = soup.find_all("img")
            images_without_alt = sum(1 for img in images if not img.get("alt"))
            json_ld = soup.find_all("script", attrs={"type": "application/ld+json"})

            links = [a.get("href", "") for a in soup.find_all("a") if a.get("href")]
            parsed_host = urlparse(url).netloc
            internal = 0
            external = 0
            for link_value in links:
                link = link_value if isinstance(link_value, str) else ""
                if not link:
                    continue
                if link.startswith("#") or link.startswith("mailto:") or link.startswith("tel:"):
                    continue
                if link.startswith("http://") or link.startswith("https://"):
                    if urlparse(link).netloc == parsed_host:
                        internal += 1
                    else:
                        external += 1
                else:
                    internal += 1

            text = soup.get_text(" ", strip=True)
            words = len([w for w in re.split(r"\s+", text) if w])

            score = 100
            issues: List[str] = []

            if not title:
                score -= 20
                issues.append("Missing title")
            elif len(title) < 30 or len(title) > 60:
                score -= 8
                issues.append("Title length should be 30-60 chars")

            desc = ""
            if meta_desc_tag:
                desc_raw = meta_desc_tag.get("content", "")
                if isinstance(desc_raw, str):
                    desc = desc_raw.strip()
            if not desc:
                score -= 15
                issues.append("Missing meta description")
            elif len(desc) < 120 or len(desc) > 160:
                score -= 6
                issues.append("Meta description should be 120-160 chars")

            if len(h1_tags) != 1:
                score -= 10
                issues.append("Page should have exactly one H1")
            if words < 300:
                score -= 10
                issues.append("Thin content (<300 words)")
            if images and images_without_alt > 0:
                score -= min(12, images_without_alt)
                issues.append("Some images are missing alt text")
            if not canonical_tag:
                score -= 6
                issues.append("Missing canonical link")
            if not robots_tag:
                score -= 4
                issues.append("Missing robots meta tag")

            score = max(0, min(100, score))

            return {
                "status_code": status,
                "score": score,
                "meta": {
                    "title": title,
                    "title_length": len(title),
                    "description": desc,
                    "description_length": len(desc),
                    "canonical": canonical_tag.get("href", "") if canonical_tag else "",
                    "robots": robots_tag.get("content", "") if robots_tag else "",
                    "lang": (soup.html.get("lang", "") if soup.html else ""),
                },
                "headings": {
                    "h1_count": len(h1_tags),
                    "h1": h1_tags,
                    "h2_count": h2_count,
                },
                "content": {
                    "word_count": words,
                    "internal_links": internal,
                    "external_links": external,
                    "json_ld_blocks": len(json_ld),
                },
                "images": {
                    "total": len(images),
                    "without_alt": images_without_alt,
                },
                "issues": issues,
            }

    @staticmethod
    def _build_summary(pages: Dict[str, Any]) -> Dict[str, Any]:
        valid = [p for p in pages.values() if isinstance(p, dict) and "score" in p]
        avg_score = round(sum(p.get("score", 0) for p in valid) / len(valid), 2) if valid else 0
        total_issues = sum(len(p.get("issues", [])) for p in valid)
        errors = sum(1 for p in pages.values() if isinstance(p, dict) and p.get("error"))

        top_issues: Dict[str, int] = {}
        for page in valid:
            for issue in page.get("issues", []):
                top_issues[issue] = top_issues.get(issue, 0) + 1

        ranked = sorted(top_issues.items(), key=lambda x: x[1], reverse=True)[:8]
        return {
            "avg_score": avg_score,
            "pages_with_errors": errors,
            "total_issues": total_issues,
            "top_issues": [{"issue": k, "count": v} for k, v in ranked],
        }
