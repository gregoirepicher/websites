/**
 * News Worker — Cloudflare Worker backend for gregoirepicher.com/news
 *
 * Endpoints:
 *   GET  /api/feeds  — Fetch, deduplicate, and cache RSS feeds
 *   POST /api/chat   — Proxy chat/digest requests to Google AI (Gemma 4)
 *   GET  /api/health — Health check
 */

import { XMLParser } from "fast-xml-parser";
import YOUTUBE_HANDLES from "../youtube-channels.json";

// ─── Types ────────────────────────────────────────────────────────────

interface Env {
  NEWS_CACHE: KVNamespace;
  GOOGLE_AI_KEY: string;
  YOUTUBE_API_KEY?: string;
}

interface Article {
  title: string;
  link: string;
  pubDate: string;
  source: string;
  thumbnail?: string;
  videoId?: string;
  duration?: string;
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
    { title: "Unreal Engine Releases", url: "https://github.com/EpicGames/UnrealEngine/releases.atom" },
    { title: "ComfyUI Blog", url: "https://blog.comfy.org/feed" },
    { title: "ComfyUI Releases", url: "https://github.com/Comfy-Org/ComfyUI/releases.atom" },
    { title: "ComfyUI-Manager Releases", url: "https://github.com/ltdrdata/ComfyUI-Manager/releases.atom" },
    { title: "ASWF", url: "https://www.aswf.io/feed/" },
    { title: "Maya Learning Channel", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCHmAXsicpLK2EHMZo5_BtDA" },
    { title: "Open Source For You", url: "https://www.opensourceforu.com/feed/" },
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
    { title: "Civitai Articles", url: "https://civitai.com/feed" },
    { title: "RunwayML Blog", url: "https://runwayml.com/blog/rss.xml" },
  ],
  "Broader Tech & AI News": [
    { title: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
    { title: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/technology-lab" },
    { title: "MIT Technology Review", url: "https://www.technologyreview.com/feed/" },
    { title: "IEEE Spectrum AI", url: "https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss" },
    { title: "ZDNet", url: "http://blogs.zdnet.com/open-source/wp-rss2.php" },
  ],
  "Research & Academic": [
    { title: "arXiv Computer Graphics", url: "https://rss.arxiv.org/rss/cs.GR" },
    { title: "arXiv Computer Vision", url: "https://rss.arxiv.org/rss/cs.CV" },
    { title: "arXiv Machine Learning", url: "https://rss.arxiv.org/rss/cs.LG" },
    { title: "Google AI Blog", url: "https://blog.research.google/feeds/posts/default" },
    { title: "Google Open Source Blog", url: "http://google-opensource.blogspot.com/feeds/posts/default" },
    { title: "Papers With Code", url: "https://paperswithcode.com/latest.rss" },
    { title: "Two Minute Papers", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCbfYPyITQ-7l4upoX8nvctg" },
    { title: "NVIDIA Research Blog", url: "https://blogs.nvidia.com/feed/" },
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

async function resolveHandle(handle: string, env: Env): Promise<FeedConfig | null> {
  const cacheKey = `yt:id:${handle.toLowerCase()}`;

  // Check KV cache first — channel IDs never change, so no expiry needed
  const cached = await env.NEWS_CACHE.get(cacheKey);
  if (cached) {
    const { title, channelId } = JSON.parse(cached);
    return { title, url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}` };
  }

  // Fetch YouTube page and extract externalId + channel name
  try {
    const res = await fetch(`https://www.youtube.com/${handle}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    const text = await res.text();

    const idMatch = text.match(/"externalId":"(UC[^"]+)"/);
    const nameMatch = text.match(/"title":"([^"]+)","description"/);
    if (!idMatch) return null;

    const channelId = idMatch[1];
    const title = nameMatch ? nameMatch[1] : handle.replace("@", "");

    // Store permanently — channel IDs never change
    await env.NEWS_CACHE.put(cacheKey, JSON.stringify({ title, channelId }));

    return { title, url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}` };
  } catch {
    return null;
  }
}

async function getYouTubeFeeds(env: Env): Promise<FeedConfig[]> {
  // Resolve handles sequentially to avoid YouTube rate limiting from Cloudflare IPs
  const feeds: FeedConfig[] = [];
  for (const handle of YOUTUBE_HANDLES as string[]) {
    const feed = await resolveHandle(handle, env);
    if (feed) feeds.push(feed);
  }
  return feeds;
}

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

  const results = await Promise.all(allPromises);
  for (const { name, articles } of results) {
    result[name] = articles;
  }

  const json = JSON.stringify({ categories: result });

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

// ─── /api/youtube Handler ─────────────────────────────────────────────
//
// Resilience strategy (to survive YouTube's flaky RSS endpoint):
//   1. Short-lived aggregate cache (15 min) for fast repeat hits.
//   2. Per-channel permanent storage in KV — each channel's latest video is
//      stored forever and only overwritten when a NEWER video is successfully
//      fetched. If a fetch fails, we fall back to the previously stored video.
//   3. Retry each feed up to 3 times before giving up.
//   4. The response is built from the union of freshly-fetched and stored
//      videos, so the display never goes blank as long as SOME channel has
//      ever been seen.

async function fetchFeedWithRetry(feed: FeedConfig, retries = 3): Promise<Article[]> {
  for (let i = 0; i < retries; i++) {
    const result = await fetchFeed(feed);
    if (result.length > 0) return result;
    if (i < retries - 1) {
      // Small backoff (250ms, 500ms) — YouTube's 404/500s are transient
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  return [];
}

function channelStoreKey(feedUrl: string): string {
  // Extract channel_id from the URL
  const m = feedUrl.match(/channel_id=([^&]+)/);
  return `yt:video:${m ? m[1] : feedUrl}`;
}

/** Convert ISO 8601 duration (PT1H2M3S) to human-readable (1:02:03) */
function formatDuration(iso: string): string {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return "";
  const h = parseInt(m[1] || "0");
  const min = parseInt(m[2] || "0");
  const sec = parseInt(m[3] || "0");
  if (h > 0) return `${h}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

/** Batch-fetch video durations from YouTube Data API v3 */
async function enrichWithDurations(videos: Article[], env: Env): Promise<void> {
  if (!env.YOUTUBE_API_KEY) return;
  const ids = videos.map((v) => v.videoId).filter(Boolean);
  if (ids.length === 0) return;

  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids.join(",")}&key=${env.YOUTUBE_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json<any>();
    const durMap = new Map<string, string>();
    for (const item of data.items || []) {
      const dur = formatDuration(item.contentDetails?.duration || "");
      if (dur) durMap.set(item.id, dur);
    }
    for (const video of videos) {
      if (video.videoId && durMap.has(video.videoId)) {
        video.duration = durMap.get(video.videoId);
      }
    }
  } catch {
    // Non-critical — durations are a nice-to-have
  }
}

async function handleYouTube(request: Request, env: Env): Promise<Response> {
  // Fast path: aggregate cache
  const cached = await env.NEWS_CACHE.get("youtube:latest");
  if (cached) {
    return new Response(cached, {
      headers: {
        ...corsHeaders(request),
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  const channels = await getYouTubeFeeds(env);

  // For each channel: try to fetch fresh; if it fails, fall back to stored.
  // Update storage only when a newer video is successfully fetched.
  const results = await Promise.all(
    channels.map(async (channel): Promise<Article | null> => {
      const storeKey = channelStoreKey(channel.url);
      const stored = await env.NEWS_CACHE.get(storeKey);
      const storedVideo: Article | null = stored ? JSON.parse(stored) : null;

      const fresh = await fetchFeedWithRetry(channel, 3);
      if (fresh.length > 0) {
        const latest = fresh[0];
        // Only overwrite storage if the fetched video is actually newer
        // (or if we have nothing stored yet)
        if (!storedVideo) {
          await env.NEWS_CACHE.put(storeKey, JSON.stringify(latest));
          return latest;
        }
        const storedTime = new Date(storedVideo.pubDate).getTime() || 0;
        const freshTime = new Date(latest.pubDate).getTime() || 0;
        if (freshTime >= storedTime) {
          await env.NEWS_CACHE.put(storeKey, JSON.stringify(latest));
          return latest;
        }
        return storedVideo;
      }

      // Fetch failed — fall back to last known good
      return storedVideo;
    })
  );

  const videos: Article[] = results.filter((v): v is Article => v !== null);
  videos.sort((a, b) => {
    const da = new Date(a.pubDate).getTime() || 0;
    const db = new Date(b.pubDate).getTime() || 0;
    return db - da;
  });

  // Enrich with durations from YouTube Data API (if key is set)
  await enrichWithDurations(videos, env);

  const json = JSON.stringify(videos);
  // Only cache the aggregate if we actually got results
  if (videos.length > 0) {
    await env.NEWS_CACHE.put("youtube:latest", json, { expirationTtl: CACHE_TTL });
  }

  return new Response(json, {
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    },
  });
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

      case "/api/youtube":
        return handleYouTube(request, env);

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
