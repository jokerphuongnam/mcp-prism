/**
 * SoT layout:
 *   ~/Library/Caches/code-prism/<projectName>-<hash>/{lang}-prism/
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const CACHE_ROOT = path.join(os.homedir(), "Library", "Caches", "code-prism");

/** Logical language ids used by detectors / env. */
export const LANGS = ["swift", "marlin", "kotlin", "js", "rust", "go", "cpp", "objc"] as const;
export type PrismLang = (typeof LANGS)[number];

/** Folder name under the project cache: swift-prism, objective-c-prism, … */
export function langPrismFolder(lang: string): string {
  if (lang === "objc") return "objective-c-prism";
  if (lang.endsWith("-prism")) return lang;
  return `${lang}-prism`;
}

export function langIdFromFolder(folder: string): string {
  if (folder === "objective-c-prism") return "objc";
  if (folder.endsWith("-prism")) return folder.slice(0, -"-prism".length);
  return folder;
}

export function sanitizeProjectName(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "project";
}

export function projectHash(projectRoot: string): string {
  const real = fs.realpathSync(projectRoot);
  return crypto.createHash("sha256").update(real).digest("hex").slice(0, 16);
}

/** e.g. LiteTrace-a1b2c3d4e5f67890 */
export function projectSlug(projectRoot: string): string {
  const real = fs.realpathSync(projectRoot);
  const name = sanitizeProjectName(path.basename(real));
  return `${name}-${projectHash(real)}`;
}

export function projectCacheDir(projectRoot: string): string {
  return path.join(CACHE_ROOT, projectSlug(projectRoot));
}

export function cacheDirFor(lang: string, projectRoot: string): string {
  return path.join(projectCacheDir(projectRoot), langPrismFolder(lang));
}

/** @deprecated alias — hash only (old layout). */
export function projectKey(projectRoot: string): string {
  return projectHash(projectRoot);
}

export interface CacheHit {
  lang: string;
  projectKey: string;
  projectSlug: string;
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

function hitFromDir(lang: string, projectRoot: string, dir: string, slug: string): CacheHit | null {
  const graphPath = path.join(dir, "prism-context.json");
  if (!fs.existsSync(graphPath)) return null;
  const sqliteCandidate = path.join(dir, "graph.sqlite");
  return {
    lang,
    projectKey: projectHash(projectRoot),
    projectSlug: slug,
    projectRoot: fs.realpathSync(projectRoot),
    cacheDir: dir,
    graphPath,
    sqlitePath: fs.existsSync(sqliteCandidate) ? sqliteCandidate : undefined,
    meta: readMeta(dir) ?? undefined,
  };
}

/** All language caches for a user project (new layout). */
export function resolveAllCachesForProject(projectRoot: string): CacheHit[] {
  if (!fs.existsSync(projectRoot)) return [];
  let real: string;
  try {
    real = fs.realpathSync(projectRoot);
  } catch {
    return [];
  }

  const hits: CacheHit[] = [];
  const slug = projectSlug(real);
  const projectDir = path.join(CACHE_ROOT, slug);

  // New layout: code-prism/<name>-<hash>/{lang}-prism/
  if (fs.existsSync(projectDir)) {
    for (const ent of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!ent.isDirectory() || !ent.name.endsWith("-prism")) continue;
      const lang = langIdFromFolder(ent.name);
      const hit = hitFromDir(lang, real, path.join(projectDir, ent.name), slug);
      if (hit) hits.push(hit);
    }
    if (hits.length > 0) return hits;
  }

  // Legacy layout: code-prism/<lang>/<hash>/
  for (const lang of LANGS) {
    const legacy = path.join(CACHE_ROOT, lang, projectHash(real));
    const hit = hitFromDir(lang, real, legacy, slug);
    if (hit) hits.push(hit);
  }
  if (hits.length > 0) return hits;

  // Fallback: scan metas for matching projectRoot
  if (!fs.existsSync(CACHE_ROOT)) return [];
  for (const projEnt of fs.readdirSync(CACHE_ROOT, { withFileTypes: true })) {
    if (!projEnt.isDirectory()) continue;
    const projDir = path.join(CACHE_ROOT, projEnt.name);
    // new layout project folder
    try {
      for (const langEnt of fs.readdirSync(projDir, { withFileTypes: true })) {
        if (!langEnt.isDirectory() || !langEnt.name.endsWith("-prism")) continue;
        const dir = path.join(projDir, langEnt.name);
        const meta = readMeta(dir);
        if (meta?.projectRoot !== real) continue;
        const hit = hitFromDir(langIdFromFolder(langEnt.name), real, dir, projEnt.name);
        if (hit) hits.push(hit);
      }
    } catch {
      // might be legacy lang folder
      if ((LANGS as readonly string[]).includes(projEnt.name)) {
        const lang = projEnt.name;
        for (const keyEnt of fs.readdirSync(projDir, { withFileTypes: true })) {
          if (!keyEnt.isDirectory()) continue;
          const dir = path.join(projDir, keyEnt.name);
          const meta = readMeta(dir);
          if (meta?.projectRoot !== real) continue;
          const hit = hitFromDir(lang, real, dir, slug);
          if (hit) hits.push(hit);
        }
      }
    }
  }
  return hits;
}

export function resolveCacheForProject(
  projectRoot: string,
  preferredLang?: string
): CacheHit | null {
  const all = resolveAllCachesForProject(projectRoot);
  if (all.length === 0) return null;
  if (preferredLang) {
    const pref = all.find((h) => h.lang === preferredLang);
    if (pref) return pref;
  }
  return all[0];
}
