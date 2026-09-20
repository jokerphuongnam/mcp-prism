/**
 * Relative / fuzzy symbol resolution over an in-memory graph.
 * Agents pass loose queries ("fetch in Store", "intensity didSet") —
 * we rank candidates and return best matches + enough context.
 */
import type { GraphNode } from "./fragment-store.js";

export interface ResolveHints {
  /** Substring expected in file path (e.g. "Store", "BlurEffect") */
  file?: string;
  /** Prefer this flavor */
  flavor?: string;
  /** Prefer this language prefix when multi-lang ids use `lang::` */
  language?: string;
  limit?: number;
}

export interface RankedHit {
  id: string;
  name: string;
  flavor: string;
  score: number;
  reasons: string[];
  file?: string;
  line?: number;
  callerCount: number;
  calleeCount: number;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\[.*?\]/g, " ") // strip [didSet] etc for tokenizing
    .replace(/[^a-z0-9_:.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s)
    .split(/[\s.:]+/)
    .filter((t) => t.length > 1);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const cur =
        a[i - 1] === b[j - 1]
          ? row[j - 1]
          : 1 + Math.min(row[j - 1], prev, row[j]);
      row[j - 1] = prev;
      prev = cur;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

function pathBase(p?: string): string {
  if (!p) return "";
  const parts = p.replace(/\\/g, "/").split("/");
  return (parts[parts.length - 1] || "").toLowerCase();
}

/**
 * Rank graph nodes against a relative query.
 */
export function rankSymbols(
  query: string,
  nodes: GraphNode[],
  callerIndex: Map<string, string[]>,
  hints: ResolveHints = {}
): RankedHit[] {
  const q = query.trim();
  if (!q || nodes.length === 0) return [];

  const qNorm = normalize(q);
  const qTokens = tokens(q);
  const limit = hints.limit ?? 8;
  const fileHint = hints.file?.toLowerCase();
  const flavorHint = hints.flavor?.toLowerCase();
  const langHint = hints.language?.toLowerCase();

  const hits: RankedHit[] = [];

  for (const n of nodes) {
    if (flavorHint && n.flavor.toLowerCase() !== flavorHint) continue;
    if (langHint && n.id.includes("::") && !n.id.toLowerCase().startsWith(`${langHint}::`)) {
      // multi-lang prefixed ids
      if (!n.id.toLowerCase().includes(`${langHint}::`) && !n.name.toLowerCase().includes(`[${langHint}]`)) {
        continue;
      }
    }

    let score = 0;
    const reasons: string[] = [];
    const idNorm = normalize(n.id);
    const nameNorm = normalize(n.name);
    const file = n.location?.absPath ?? "";
    const fileNorm = file.toLowerCase();
    const fileName = pathBase(file);

    // Exact / strong name matches
    if (nameNorm === qNorm || idNorm === qNorm) {
      score += 120;
      reasons.push("exact");
    } else if (nameNorm.startsWith(qNorm) || idNorm.endsWith(qNorm) || idNorm.includes(`::${qNorm}`)) {
      score += 80;
      reasons.push("prefix/suffix");
    } else if (nameNorm.includes(qNorm) || idNorm.includes(qNorm)) {
      score += 55;
      reasons.push("substring");
    }

    // Token overlap (order-free): "fetch store" matches Store.fetch
    const idTokens = new Set(tokens(`${n.id} ${n.name} ${fileName}`));
    let overlap = 0;
    for (const t of qTokens) {
      if (idTokens.has(t)) overlap += 1;
      else {
        // fuzzy token
        for (const it of idTokens) {
          if (it.includes(t) || t.includes(it)) {
            overlap += 0.6;
            break;
          }
          if (Math.min(it.length, t.length) >= 4 && levenshtein(it, t) <= 2) {
            overlap += 0.4;
            break;
          }
        }
      }
    }
    if (overlap > 0) {
      score += overlap * 22;
      reasons.push(`tokens:${overlap.toFixed(1)}`);
    }

    // File hint
    if (fileHint) {
      if (fileNorm.includes(fileHint) || fileName.includes(fileHint)) {
        score += 35;
        reasons.push("file");
      }
    } else {
      // If a query token matches filename, boost
      for (const t of qTokens) {
        if (t.length >= 3 && (fileName.includes(t) || fileNorm.includes(`/${t}`))) {
          score += 18;
          reasons.push("file-token");
          break;
        }
      }
    }

    // Flavor words in query
    const flavorWords = ["class", "struct", "func", "function", "var", "protocol", "enum", "actor", "didset", "willset"];
    for (const w of flavorWords) {
      if (qNorm.includes(w) && n.flavor.toLowerCase().includes(w.replace("function", "func"))) {
        score += 12;
        reasons.push(`flavor:${w}`);
      }
    }
    if (qNorm.includes("didset") && (n.id.includes("[didSet]") || n.name.includes("didSet"))) {
      score += 25;
      reasons.push("didSet");
    }

    // Centrality: more callers → more likely the intended symbol
    const callerCount = callerIndex.get(n.id)?.length ?? 0;
    const calleeCount = (n.calls?.length ?? 0) + (n.inits?.length ?? 0);
    if (callerCount > 0) {
      score += Math.min(20, Math.log2(1 + callerCount) * 6);
      reasons.push(`callers:${callerCount}`);
    }

    // Small fuzzy on bare name
    if (score < 40 && qTokens.length === 1) {
      const bare = qTokens[0];
      const d = levenshtein(bare, nameNorm.split(" ")[0] || nameNorm);
      if (d <= 2 && bare.length >= 4) {
        score += 30 - d * 8;
        reasons.push(`fuzzy:${d}`);
      }
    }

    if (score < 18) continue;

    hits.push({
      id: n.id,
      name: n.name,
      flavor: n.flavor,
      score: Math.round(score * 10) / 10,
      reasons,
      file: file || undefined,
      line: n.location?.line,
      callerCount,
      calleeCount,
    });
  }

  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return hits.slice(0, limit);
}

/** Parse a free-text ask into query + soft hints. */
export function parseAskQuery(ask: string): { query: string; hints: ResolveHints } {
  const hints: ResolveHints = {};
  let q = ask.trim();

  const fileIn = q.match(/\b(?:in|trong)\s+([A-Za-z0-9_./-]+)/i);
  if (fileIn) {
    hints.file = fileIn[1].replace(/\.(swift|ts|tsx|js|kt|rs|go|m|mm|cpp|h)$/i, "");
    q = q.replace(fileIn[0], " ").trim();
  }

  const flavorIn = q.match(
    /\b(class|struct|func|function|protocol|enum|actor|variable|var|didset|willset)\b/i
  );
  if (flavorIn) {
    const f = flavorIn[1].toLowerCase();
    hints.flavor =
      f === "func" || f === "function"
        ? "function"
        : f === "var" || f === "variable"
          ? "variable"
          : f === "didset" || f === "willset"
            ? undefined // keep in query tokens
            : f;
  }

  const langIn = q.match(/\b(swift|js|ts|typescript|kotlin|rust|go|cpp|objc|marlin)\b/i);
  if (langIn) {
    let lang = langIn[1].toLowerCase();
    if (lang === "ts" || lang === "typescript") lang = "js";
    hints.language = lang;
    q = q.replace(langIn[0], " ").trim();
  }

  return { query: q.replace(/\s+/g, " ").trim() || ask.trim(), hints };
}
