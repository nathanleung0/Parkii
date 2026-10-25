"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";

// Semantic search over the Apify-crawled SFMTA rule pages in Elastic, used by the voice agent.
// TypeScript port of ElasticRetrieval.search_sources (agents/providers/retrieval/elastic.py): it runs the
// scoped Agent Builder ES|QL tool directly, and the scope is set here in trusted code, never by the model.
// Index + tools are created by `python -m agents.seed_rules` (ELASTIC_INDEX=parksight-rules).

const TOOL_WORKSPACE = "vortex.search_sources_workspace";
const USER_ID = "parkii-demo"; // same scope as agents/rules_service.py
const WORKSPACE = "castro";
const MAX_HITS = 3;
const MAX_EXCERPT_CHARS = 500;
const MAX_QUERY_CHARS = 500;
const TIMEOUT_MS = 20_000;

export type RuleHit = { title: string; url: string | null; excerpt: string; score: number | null };
export type RulesSearch = { status: string; query: string; hits: RuleHit[] };

type Row = Record<string, unknown>;

// Find ES|QL-style {columns:[{name}], values:[[...]]} anywhere in the response (shape is not documented).
function rows(obj: unknown): Row[] {
  const found: Row[] = [];
  if (Array.isArray(obj)) {
    for (const child of obj) found.push(...rows(child));
  } else if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    if (Array.isArray(o.columns) && Array.isArray(o.values)) {
      const names = o.columns.map((c) => (c && typeof c === "object" ? (c as { name?: string }).name : String(c)));
      for (const vals of o.values) {
        if (Array.isArray(vals)) found.push(Object.fromEntries(names.map((n, i) => [n, vals[i]])));
      }
    }
    for (const child of Object.values(o)) found.push(...rows(child));
  }
  return found;
}

// Up-to-500-char window of `content` with the most query-word overlap.
function excerpt(content: string, query: string): string {
  const text = content.replace(/\s+/g, " ").trim();
  if (text.length <= MAX_EXCERPT_CHARS) return text;
  const words = [...new Set((query.toLowerCase().match(/\w+/g) ?? []).filter((w) => w.length > 2))];
  let best = 0;
  let bestScore = -1;
  for (let start = 0; start < text.length - MAX_EXCERPT_CHARS + 100; start += 100) {
    const window = text.slice(start, start + MAX_EXCERPT_CHARS).toLowerCase();
    const score = words.reduce((n, w) => n + window.split(w).length - 1, 0);
    if (score > bestScore) [best, bestScore] = [start, score];
  }
  return text.slice(best, best + MAX_EXCERPT_CHARS);
}

function errorCode(status: number) {
  return ({ 401: "UNAUTHORIZED", 403: "UNAUTHORIZED", 404: "NOT_FOUND", 408: "PROVIDER_TIMEOUT", 504: "PROVIDER_TIMEOUT" } as Record<number, string>)[status] ?? "INTERNAL_ERROR";
}

export const searchRules = internalAction({
  args: { query: v.string() },
  handler: async (_ctx, args): Promise<RulesSearch> => {
    const query = args.query.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
    const kibana = process.env.ELASTIC_KIBANA_URL?.replace(/\/+$/, "");
    const apiKey = process.env.ELASTIC_API_KEY;
    if (!kibana || !apiKey) return { status: "not_configured", query, hits: [] };
    if (!query) return { status: "error:VALIDATION_ERROR", query, hits: [] };

    let body: unknown;
    try {
      const res = await fetch(`${kibana}/api/agent_builder/tools/_execute`, {
        method: "POST",
        headers: {
          Authorization: `ApiKey ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "kbn-xsrf": "true",
        },
        body: JSON.stringify({
          tool_id: TOOL_WORKSPACE,
          tool_params: { user_id: USER_ID, workspace_id: WORKSPACE, query },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // Provider bodies may echo keys or queries, so only the status code is reported.
      if (!res.ok) return { status: `error:${errorCode(res.status)}`, query, hits: [] };
      body = await res.json();
    } catch (e) {
      return { status: (e as Error).name === "TimeoutError" ? "error:PROVIDER_TIMEOUT" : "error:NETWORK", query, hits: [] };
    }

    const hits: RuleHit[] = rows(body)
      // Trusted scope check, independent of what the tool returned.
      .filter((r) => r.user_id === USER_ID && r.workspace_id === WORKSPACE)
      .slice(0, MAX_HITS)
      .map((r) => ({
        title: String(r.title ?? "SFMTA page"),
        url: typeof r.url === "string" ? r.url : null,
        excerpt: excerpt(String(r.content ?? ""), query),
        score: typeof r._score === "number" ? r._score : null,
      }));
    return { status: "ok", query, hits };
  },
});
