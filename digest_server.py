"""
News Digest Server — Local backend for news.html
Fetches RSS feeds server-side and calls Ollama (Gemma 4) for AI digests.

Setup:
    1. Install Ollama from https://ollama.com
    2. ollama pull gemma4:26b
    3. pip install flask flask-cors requests feedparser
    4. python digest_server.py
"""

import time
import feedparser
from flask import Flask, request, jsonify
from flask_cors import CORS
import requests

app = Flask(__name__)
CORS(app)

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "gemma4:26b"

CATEGORIES = {
    "Animation & VFX Industry": [
        {"title": "CG Channel", "url": "https://www.cgchannel.com/feed"},
        {"title": "STASH", "url": "https://stashmedia.tv/feed"},
        {"title": "VFX Voice", "url": "https://www.vfxvoice.com/feed"},
        {"title": "Animation World Network", "url": "https://www.awn.com/feed"},
        {"title": "befores & afters", "url": "https://beforesandafters.com/feed"},
        {"title": "80.lv", "url": "https://80.lv/feed"},
        {"title": "fxguide", "url": "https://www.fxguide.com/feed"},
        {"title": "Cartoon Brew", "url": "https://www.cartoonbrew.com/feed"},
        {"title": "Creative Bloq", "url": "https://www.creativebloq.com/feeds.xml"},
        {"title": "CGW Articles", "url": "http://www.cgw.com/Publications/Articles-from-Cgw-com/RSS.xml"},
        {"title": "CGW News", "url": "http://www.cgw.com/Press-Center/News-from-CGW-com/RSS.xml"},
        {"title": "Animated Views", "url": "http://www.animated-news.com/feed/"},
        {"title": "Animation Magazine", "url": "https://www.animationmagazine.net/feed"},
    ],
    "DCC Tools & Pipeline": [
        {"title": "CGSociety", "url": "https://cgsociety.org/feed"},
        {"title": "Autodesk Area", "url": "https://area.autodesk.com/feed/"},
        {"title": "SideFX (Houdini)", "url": "https://www.sidefx.com/feed/news/"},
        {"title": "Blender.org News", "url": "https://www.blender.org/feed/"},
        {"title": "Blender Nation", "url": "https://www.blendernation.com/feed/"},
        {"title": "Blender Dev Blog", "url": "https://code.blender.org/feed/"},
        {"title": "Unreal Engine", "url": "https://www.unrealengine.com/rss"},
        {"title": "ComfyUI Blog", "url": "https://blog.comfy.org/feed"},
        {"title": "ComfyUI Releases", "url": "https://github.com/Comfy-Org/ComfyUI/releases.atom"},
        {"title": "ComfyUI-Manager Releases", "url": "https://github.com/ltdrdata/ComfyUI-Manager/releases.atom"},
        {"title": "ASWF", "url": "https://www.aswf.io/feed/"},
    ],
    "Generative AI & Synthetic Media": [
        {"title": "The Decoder", "url": "https://the-decoder.com/feed/"},
        {"title": "Synthedia", "url": "https://synthedia.substack.com/feed"},
        {"title": "AI Models Digest", "url": "https://aimodels.substack.com/feed"},
        {"title": "VentureBeat AI", "url": "https://venturebeat.com/category/ai/feed/"},
        {"title": "Hugging Face Blog", "url": "https://huggingface.co/blog/feed.xml"},
        {"title": "Stability AI Blog", "url": "https://stability.ai/feed"},
        {"title": "Replicate Blog", "url": "https://replicate.com/blog/rss"},
        {"title": "MarkTechPost", "url": "https://www.marktechpost.com/feed/"},
    ],
    "Broader Tech & AI News": [
        {"title": "TechCrunch AI", "url": "https://techcrunch.com/category/artificial-intelligence/feed/"},
        {"title": "Ars Technica", "url": "https://feeds.arstechnica.com/arstechnica/technology-lab"},
        {"title": "MIT Technology Review", "url": "https://www.technologyreview.com/feed/"},
        {"title": "IEEE Spectrum AI", "url": "https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss"},
        {"title": "ZDNet", "url": "http://blogs.zdnet.com/open-source/wp-rss2.php"},
    ],
    "Research & Academic": [
        {"title": "arXiv Computer Graphics", "url": "https://arxiv.org/rss/cs.GR"},
        {"title": "arXiv Computer Vision", "url": "https://arxiv.org/rss/cs.CV"},
        {"title": "Google AI Blog", "url": "https://blog.research.google/feeds/posts/default"},
        {"title": "Google Open Source Blog", "url": "http://google-opensource.blogspot.com/feeds/posts/default"},
    ],
    "Studios & Production": [
        {"title": "Framestore", "url": "https://www.framestore.com/feed"},
        {"title": "DNEG", "url": "https://www.dneg.com/feed/"},
        {"title": "Pixar", "url": "https://www.pixar.com/feed"},
        {"title": "ILM", "url": "https://www.ilm.com/feed/"},
        {"title": "Deadline Film", "url": "http://deadline.com/v/film/feed/"},
        {"title": "Variety Film", "url": "http://variety.com/v/film/feed/"},
    ],
}

ITEMS_PER_FEED = 5


# ─── Feed Fetching ─────────────────────────────────────────────────────

def fetch_feed(feed_url, feed_title):
    """Fetch a single RSS feed and return normalized articles."""
    try:
        d = feedparser.parse(feed_url)
        articles = []
        for entry in d.entries[:ITEMS_PER_FEED]:
            pub = ""
            if hasattr(entry, "published"):
                pub = entry.published
            elif hasattr(entry, "updated"):
                pub = entry.updated
            articles.append({
                "title": entry.get("title", ""),
                "link": entry.get("link", ""),
                "pubDate": pub,
                "source": feed_title,
            })
        return articles
    except Exception:
        return []


@app.route("/feeds", methods=["GET"])
def feeds():
    """Fetch all RSS feeds server-side and return grouped articles."""
    result = {}
    for cat_name, feed_list in CATEGORIES.items():
        all_articles = []
        for feed in feed_list:
            items = fetch_feed(feed["url"], feed["title"])
            all_articles.extend(items)

        # Sort by date descending
        def parse_date(a):
            try:
                return time.mktime(feedparser._parse_date(a["pubDate"]))
            except Exception:
                return 0
        all_articles.sort(key=parse_date, reverse=True)

        # Deduplicate by normalized title
        seen = set()
        deduped = []
        for a in all_articles:
            key = "".join(c for c in a["title"].lower() if c.isalnum())[:60]
            if key not in seen:
                seen.add(key)
                deduped.append(a)
        result[cat_name] = deduped

    return jsonify(result)


# ─── AI Digest ──────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are an AI news assistant for a CG/VFX industry professional's website. You have access to the latest articles from curated RSS feeds across Animation, VFX, Pipeline Tools, AI, and more.

When answering questions:
- Be specific and reference actual article titles and sources
- If asked to filter or search, look through ALL provided articles carefully
- Include article URLs so users can click through
- Keep answers concise and well-organized using markdown
- If asked for a digest, prioritize by significance: major launches > industry shifts > routine updates
- Deduplicate stories that appear from multiple sources
- Use a professional but approachable tone

If no articles match the user's query, say so honestly rather than making things up."""


@app.route("/digest", methods=["POST"])
def digest():
    data = request.get_json()
    if not data or "articles" not in data:
        return jsonify({"error": "No articles provided"}), 400

    articles = data["articles"]
    question = data.get("question", "Produce a prioritized daily digest of these articles.")

    article_text = []
    for category, items in articles.items():
        if not items:
            continue
        article_text.append(f"\n### {category}")
        for item in items:
            date = item.get("date", item.get("pubDate", ""))
            source = item.get("source", "")
            title = item.get("title", "")
            link = item.get("link", "")
            article_text.append(f"- [{title}]({link}) — {source}, {date}")

    prompt = (
        "Here are today's collected news articles:\n"
        + "\n".join(article_text)
        + f"\n\nUser question: {question}"
    )

    try:
        response = requests.post(
            OLLAMA_URL,
            json={
                "model": MODEL,
                "system": SYSTEM_PROMPT,
                "prompt": prompt,
                "stream": False,
                "options": {
                    "num_ctx": 8192,
                    "temperature": 0.3,
                },
            },
            timeout=120,
        )
        response.raise_for_status()
        result = response.json()
        digest_text = result.get("response", "No response from model.")
        return jsonify({"digest": digest_text})
    except requests.ConnectionError:
        return jsonify({
            "error": "Cannot connect to Ollama. Is it running? (ollama serve)"
        }), 502
    except requests.Timeout:
        return jsonify({
            "error": "Ollama took too long to respond. The model may still be loading."
        }), 504
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/health", methods=["GET"])
def health():
    try:
        r = requests.get("http://localhost:11434/api/tags", timeout=5)
        models = [m["name"] for m in r.json().get("models", [])]
        has_gemma = any("gemma4" in m for m in models)
        return jsonify({
            "status": "ok",
            "ollama": "connected",
            "models": models,
            "gemma4_available": has_gemma,
        })
    except Exception:
        return jsonify({
            "status": "degraded",
            "ollama": "not reachable",
        }), 503


if __name__ == "__main__":
    print("News digest server starting on http://localhost:5000")
    print(f"AI model: {MODEL}")
    print("Endpoints:")
    print("  GET  /feeds   — fetch all RSS feeds")
    print("  POST /digest  — generate AI digest")
    print("  GET  /health  — check Ollama status")
    app.run(host="127.0.0.1", port=5000, debug=False)
