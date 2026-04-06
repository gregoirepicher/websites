/**
 * News Worker — Cloudflare Worker backend for gregoirepicher.com/news
 *
 * Endpoints:
 *   GET  /api/feeds  — Fetch, deduplicate, and cache RSS feeds
 *   POST /api/chat   — Proxy chat/digest requests to Google AI (Gemma 4)
 *   GET  /api/health — Health check
 */

import { XMLParser } from "fast-xml-parser";

// ─── Types ────────────────────────────────────────────────────────────

interface Env {
  NEWS_CACHE: KVNamespace;
  GOOGLE_AI_KEY: string;
}

interface Article {
  title: string;
  link: string;
  pubDate: string;
  source: string;
  thumbnail?: string;
  videoId?: string;
}

interface FeedConfig {
  title: string;
  url: string;
}

// ─── Feed Configuration ──────────────────────────────────────────────

const CATEGORIES: Record<string, FeedConfig[]> = {
  "Animation & VFX Industry": [
    { title: "CG Channel", url: "https://www.cgchannel.com/feed" },
    { title: "STASH", url: "https://stashmedia.tv/feed" },
    { title: "VFX Voice", url: "https://www.vfxvoice.com/feed" },
    { title: "Animation World Network", url: "https://www.awn.com/feed" },
    { title: "befores & afters", url: "https://beforesandafters.com/feed" },
    { title: "80.lv", url: "https://80.lv/feed" },
    { title: "fxguide", url: "https://www.fxguide.com/feed" },
    { title: "Cartoon Brew", url: "https://www.cartoonbrew.com/feed" },
    { title: "Creative Bloq", url: "https://www.creativebloq.com/feeds.xml" },
    { title: "CGW Articles", url: "http://www.cgw.com/Publications/Articles-from-Cgw-com/RSS.xml" },
    { title: "CGW News", url: "http://www.cgw.com/Press-Center/News-from-CGW-com/RSS.xml" },
    { title: "Animated Views", url: "http://www.animated-news.com/feed/" },
    { title: "Animation Magazine", url: "https://www.animationmagazine.net/feed" },
  ],
  "DCC Tools & Pipeline": [
    { title: "CGSociety", url: "https://cgsociety.org/feed" },
    { title: "Autodesk Area", url: "https://area.autodesk.com/feed/" },
    { title: "SideFX (Houdini)", url: "https://www.sidefx.com/feed/news/" },
    { title: "Blender.org News", url: "https://www.blender.org/feed/" },
    { title: "Blender Nation", url: "https://www.blendernation.com/feed/" },
    { title: "Blender Dev Blog", url: "https://code.blender.org/feed/" },
    { title: "Unreal Engine", url: "https://www.unrealengine.com/rss" },
    { title: "ComfyUI Blog", url: "https://blog.comfy.org/feed" },
    { title: "ComfyUI Releases", url: "https://github.com/Comfy-Org/ComfyUI/releases.atom" },
    { title: "ComfyUI-Manager Releases", url: "https://github.com/ltdrdata/ComfyUI-Manager/releases.atom" },
    { title: "ASWF", url: "https://www.aswf.io/feed/" },
  ],
  "Generative AI & Synthetic Media": [
    { title: "The Decoder", url: "https://the-decoder.com/feed/" },
    { title: "Synthedia", url: "https://synthedia.substack.com/feed" },
    { title: "AI Models Digest", url: "https://aimodels.substack.com/feed" },
    { title: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/" },
    { title: "Hugging Face Blog", url: "https://huggingface.co/blog/feed.xml" },
    { title: "Stability AI Blog", url: "https://stability.ai/feed" },
    { title: "Replicate Blog", url: "https://replicate.com/blog/rss" },
    { title: "MarkTechPost", url: "https://www.marktechpost.com/feed/" },
  ],
  "Broader Tech & AI News": [
    { title: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
    { title: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/technology-lab" },
    { title: "MIT Technology Review", url: "https://www.technologyreview.com/feed/" },
    { title: "IEEE Spectrum AI", url: "https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss" },
    { title: "ZDNet", url: "http://blogs.zdnet.com/open-source/wp-rss2.php" },
  ],
  "Research & Academic": [
    { title: "arXiv Computer Graphics", url: "https://arxiv.org/rss/cs.GR" },
    { title: "arXiv Computer Vision", url: "https://arxiv.org/rss/cs.CV" },
    { title: "Google AI Blog", url: "https://blog.research.google/feeds/posts/default" },
    { title: "Google Open Source Blog", url: "http://google-opensource.blogspot.com/feeds/posts/default" },
  ],
  "Studios & Production": [
    { title: "Framestore", url: "https://www.framestore.com/feed" },
    { title: "DNEG", url: "https://www.dneg.com/feed/" },
    { title: "Pixar", url: "https://www.pixar.com/feed" },
    { title: "ILM", url: "https://www.ilm.com/feed/" },
    { title: "Deadline Film", url: "http://deadline.com/v/film/feed/" },
    { title: "Variety Film", url: "http://variety.com/v/film/feed/" },
  ],
};

const YOUTUBE_CHANNELS: FeedConfig[] = [
  { title: "Bad X Studio", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCOQ6GGRyyu8S3jahnUz2zHw" },
  { title: "MrEflow", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UChpleBmo18P08aKCIgti38g" },
  { title: "Pixel Artistry", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCRGb8yCnI5-upL3hT4oiOZw" },
  { title: "Pixaroma", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCmMbwA-s3GZDKVzGZ-kPwaQ" },
  { title: "Stefan AI 3D", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCRW08KcTVjXEmBzBsVl7XjA" },
  { title: "Theoretically Media", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UC9Ryt3XOGYBoAJVsBHNGDzA" },
  { title: "Curious Refuge", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UClnFtyUEaxQOCd1s5NKYGFA" },
  { title: "Inspiration Tuts", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCDdv3C21EFv7MxBMu70OExw" },
  { title: "Matt Vid Pro", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UC5Wz4fFacYuON6IKbhSa7Zw" },
  { title: "Comfy Org", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCsOXR1n2MR15vuK2htE5EkQ" },
  { title: "Unreal Sensei", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCue7TFlrt9FxXarpsl872Dg" },
];

const ITEMS_PER_FEED = 5;
const CACHE_TTL = 900; // 15 minutes
const ALLOWED_ORIGINS = [
  "https://gregoirepicher.com",
  "https://www.gregoirepicher.com",
  "http://localhost:8080",
];

// ─── CORS ─────────────────────────────────────────────────────────────

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function handleOptions(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

// ─── RSS Parsing ──────────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

async function fetchFeed(feed: FeedConfig): Promise<Article[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(feed.url, {
      signal: controller.signal,
      headers: { "User-Agent": "NewsAggregator/1.0" },
    });
    clearTimeout(timeout);

    if (!res.ok) return [];

    const xml = await res.text();
    const parsed = xmlParser.parse(xml);

    // Handle RSS 2.0
    const channel = parsed?.rss?.channel;
    if (channel) {
      const items = Array.isArray(channel.item)
        ? channel.item
        : channel.item
        ? [channel.item]
        : [];
      return items.slice(0, ITEMS_PER_FEED).map((item: any) => ({
        title: item.title || "",
        link: item.link || "",
        pubDate: item.pubDate || item["dc:date"] || "",
        source: feed.title,
      }));
    }

    // Handle Atom
    const atomFeed = parsed?.feed;
    if (atomFeed) {
      const entries = Array.isArray(atomFeed.entry)
        ? atomFeed.entry
        : atomFeed.entry
        ? [atomFeed.entry]
        : [];
      return entries.slice(0, ITEMS_PER_FEED).map((entry: any) => {
        let link = "";
        if (typeof entry.link === "string") {
          link = entry.link;
        } else if (Array.isArray(entry.link)) {
          const alt = entry.link.find((l: any) => l["@_rel"] === "alternate");
          link = alt?.["@_href"] || entry.link[0]?.["@_href"] || "";
        } else if (entry.link?.["@_href"]) {
          link = entry.link["@_href"];
        }

        // Extract YouTube thumbnail and video ID if available
        const videoId = entry["yt:videoId"] || "";
        const thumbnail = entry["media:group"]?.["media:thumbnail"]?.["@_url"] || "";

        return {
          title: typeof entry.title === "string" ? entry.title : entry.title?.["#text"] || "",
          link,
          pubDate: entry.published || entry.updated || "",
          source: feed.title,
          ...(thumbnail && { thumbnail }),
          ...(videoId && { videoId }),
        };
      });
    }

    // Handle RDF/RSS 1.0
    const rdf = parsed?.["rdf:RDF"];
    if (rdf) {
      const items = Array.isArray(rdf.item) ? rdf.item : rdf.item ? [rdf.item] : [];
      return items.slice(0, ITEMS_PER_FEED).map((item: any) => ({
        title: item.title || "",
        link: item.link || "",
        pubDate: item["dc:date"] || "",
        source: feed.title,
      }));
    }

    return [];
  } catch {
    return [];
  }
}

function deduplicateArticles(articles: Article[]): Article[] {
  const seen = new Set<string>();
  return articles.filter((a) => {
    const key = a.title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 60);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── /api/feeds Handler ───────────────────────────────────────────────

async function handleFeeds(request: Request, env: Env): Promise<Response> {
  // Check KV cache first
  const cached = await env.NEWS_CACHE.get("feeds:latest");
  if (cached) {
    return new Response(cached, {
      headers: {
        ...corsHeaders(request),
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  // Fetch all feeds in parallel
  const result: Record<string, Article[]> = {};

  const categoryEntries = Object.entries(CATEGORIES);
  const allPromises = categoryEntries.map(async ([catName, feeds]) => {
    const feedResults = await Promise.allSettled(feeds.map((f) => fetchFeed(f)));
    const articles: Article[] = [];
    for (const r of feedResults) {
      if (r.status === "fulfilled") articles.push(...r.value);
    }
    // Sort by date descending
    articles.sort((a, b) => {
      const da = new Date(a.pubDate).getTime() || 0;
      const db = new Date(b.pubDate).getTime() || 0;
      return db - da;
    });
    return { name: catName, articles: deduplicateArticles(articles) };
  });

  // Fetch YouTube channels in parallel — keep only the latest video per channel
  const ytPromise = (async () => {
    const feedResults = await Promise.allSettled(YOUTUBE_CHANNELS.map((f) => fetchFeed(f)));
    const videos: Article[] = [];
    for (const r of feedResults) {
      if (r.status === "fulfilled" && r.value.length > 0) {
        // Each feed is already sorted by date; take only the first (newest) video
        videos.push(r.value[0]);
      }
    }
    videos.sort((a, b) => {
      const da = new Date(a.pubDate).getTime() || 0;
      const db = new Date(b.pubDate).getTime() || 0;
      return db - da;
    });
    return videos;
  })();

  const [results, ytVideos] = await Promise.all([Promise.all(allPromises), ytPromise]);
  for (const { name, articles } of results) {
    result[name] = articles;
  }

  const json = JSON.stringify({ categories: result, youtube: ytVideos });

  // Store in KV with TTL
  await env.NEWS_CACHE.put("feeds:latest", json, { expirationTtl: CACHE_TTL });

  return new Response(json, {
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    },
  });
}

// ─── /api/chat Handler ────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI news assistant for a CG/VFX industry professional's website (gregoirepicher.com). You have access to the latest articles from curated RSS feeds across Animation, VFX, Pipeline Tools, AI, and more.

When answering questions:
- Be specific and reference actual article titles and sources
- If asked to filter or search, look through ALL provided articles carefully
- Include article URLs so users can click through
- Keep answers concise and well-organized using markdown
- If asked for a digest, prioritize by significance: major launches > industry shifts > routine updates
- Deduplicate stories that appear from multiple sources
- Use a professional but approachable tone

If no articles match the user's query, say so honestly rather than making things up.`;

async function handleChat(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    articles?: Record<string, Article[]>;
    question: string;
  }>();

  if (!body?.question) {
    return new Response(JSON.stringify({ error: "No question provided" }), {
      status: 400,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
    });
  }

  // Build article context
  let articleContext = "";
  if (body.articles) {
    for (const [cat, items] of Object.entries(body.articles)) {
      if (!items?.length) continue;
      articleContext += `\n### ${cat}\n`;
      for (const item of items) {
        articleContext += `- [${item.title}](${item.link}) — ${item.source}, ${item.pubDate || "no date"}\n`;
      }
    }
  }

  const userPrompt = articleContext
    ? `Here are the current news articles:\n${articleContext}\n\nUser question: ${body.question}`
    : body.question;

  // Call Google AI Studio (Gemma 4)
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:streamGenerateContent?alt=sse&key=${env.GOOGLE_AI_KEY}`;

  try {
    const aiResponse = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 4096,
        },
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      return new Response(
        JSON.stringify({ error: `AI API error: ${aiResponse.status}`, details: errText }),
        {
          status: 502,
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        }
      );
    }

    // Stream the SSE response back to the browser
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Process the SSE stream in the background
    (async () => {
      const reader = aiResponse.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6).trim();
              if (!data || data === "[DONE]") continue;
              try {
                const parsed = JSON.parse(data);
                const parts = parsed?.candidates?.[0]?.content?.parts ?? [];
                for (const part of parts) {
                  // Skip thinking parts (thought: true) — only send actual response text
                  if (part.thought === true) continue;
                  if (part.text) {
                    await writer.write(encoder.encode(`data: ${JSON.stringify({ text: part.text })}\n\n`));
                  }
                }
              } catch {
                // skip malformed chunks
              }
            }
          }
        }
      } catch (err) {
        // stream ended or errored
      } finally {
        await writer.write(encoder.encode("data: [DONE]\n\n"));
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        ...corsHeaders(request),
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: "Failed to reach AI API", details: err.message }),
      {
        status: 502,
        headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      }
    );
  }
}

// ─── Router ───────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return handleOptions(request);
    }

    switch (url.pathname) {
      case "/api/feeds":
        return handleFeeds(request, env);

      case "/api/chat":
        if (request.method !== "POST") {
          return new Response("Method not allowed", { status: 405 });
        }
        return handleChat(request, env);

      case "/api/health":
        return new Response(
          JSON.stringify({ status: "ok", model: "gemma-4-31b-it" }),
          {
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          }
        );

      default:
        return new Response("Not found", { status: 404 });
    }
  },
};
