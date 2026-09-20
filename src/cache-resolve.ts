/**
 * Resolve Code Prism SoT in ~/Library/Caches/code-prism/<lang>/<projectKey>/
 * Never reads/writes SoT inside the user's project tree.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const CACHE_ROOT = path.join(os.homedir(), "Library", "Caches", "code-prism");

export const LANGS = ["swift", "marlin", "kotlin", "js", "rust", "go", "cpp", "objc"] as const;
export type PrismLang = (typeof LANGS)[number];

export function projectKey(projectRoot: string): string {
  const real = fs.realpathSync(projectRoot);
  return crypto.createHash("sha256").update(real).digest("hex").slice(0, 16);
}

export function cacheDirFor(lang: string, key: string): string {
  return path.join(CACHE_ROOT, lang, key);
}

export interface CacheHit {
  lang: string;
  projectKey: string;
  projectRoot: string;
  cacheDir: string;
  graphPath: string;
  sqlitePath?: string;
  meta?: Record<string, unknown>;
}

function readMeta(dir: string): Record<string, unknown> | null {
  const p = path.join(dir, "meta.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

/** Find cache entry for a user project path. */
export function resolveCacheForProject(
  projectRoot: string,
  preferredLang?: string
): CacheHit | null {
  if (!fs.existsSync(projectRoot)) return null;
  let real: string;
  try {
    real = fs.realpathSync(projectRoot);
  } catch {
    return null;
  }
  const key = projectKey(real);
  const order = preferredLang
    ? [preferredLang, ...LANGS.filter((l) => l !== preferredLang)]
    : [...LANGS];

  for (const lang of order) {
    const dir = cacheDirFor(lang, key);
    const graphPath = path.join(dir, "prism-context.json");
    if (!fs.existsSync(graphPath)) continue;
    const sqliteCandidate = path.join(dir, "graph.sqlite");
    const meta = readMeta(dir) ?? undefined;
    // Prefer exact projectRoot match in meta when present
    if (meta?.projectRoot && String(meta.projectRoot) !== real) {
      // still allow key match (realpath-based)
    }
    return {
      lang,
      projectKey: key,
      projectRoot: real,
      cacheDir: dir,
      graphPath,
      sqlitePath: fs.existsSync(sqliteCandidate) ? sqliteCandidate : undefined,
      meta,
    };
  }

  // Fallback: scan all langs for meta.projectRoot === real (if key scheme changes)
  if (!fs.existsSync(CACHE_ROOT)) return null;
  for (const lang of LANGS) {
    const langDir = path.join(CACHE_ROOT, lang);
    if (!fs.existsSync(langDir)) continue;
    for (const ent of fs.readdirSync(langDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(langDir, ent.name);
      const meta = readMeta(dir);
      if (meta?.projectRoot === real) {
        const graphPath = path.join(dir, "prism-context.json");
        if (!fs.existsSync(graphPath)) continue;
        const sqliteCandidate = path.join(dir, "graph.sqlite");
        return {
          lang,
          projectKey: ent.name,
          projectRoot: real,
          cacheDir: dir,
          graphPath,
          sqlitePath: fs.existsSync(sqliteCandidate) ? sqliteCandidate : undefined,
          meta: meta ?? undefined,
        };
      }
    }
  }
  return null;
}
