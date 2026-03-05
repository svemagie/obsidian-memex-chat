import { App, TFile } from "obsidian";
import { promises as fsp } from "fs";
import { join, relative, dirname } from "path";
import type { SearchResult } from "./VaultSearch";

export const EMBEDDING_MODELS = [
  { id: "TaylorAI/bge-micro-v2", name: "BGE Micro v2 (schnell, 384-dim, empfohlen)" },
  { id: "Xenova/all-MiniLM-L6-v2", name: "MiniLM L6 v2 (384-dim)" },
  { id: "Xenova/multilingual-e5-small", name: "Multilingual E5 Small (mehrsprachig, DE/EN)" },
  { id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", name: "Multilingual MiniLM L12 (mehrsprachig)" },
];

interface EmbedCacheEntry { mtime: number; vec: number[] }
interface Manifest { model: string; version: number }

/**
 * Semantic search engine using Transformers.js for local embeddings.
 *
 * All data lives under <vault>/.memex-chat/:
 *   models/                            — downloaded ONNX model files (via env.cacheDir)
 *   embeddings/.manifest.json          — model name + version
 *   embeddings/some/note.ajson         — { mtime, vec }
 *
 * WASM runtime is loaded from CDN (cdn.jsdelivr.net) on first use.
 */
export class EmbedSearch {
  private app: App;
  private modelId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pipe: ((text: string, opts: object) => Promise<{ data: Float32Array }>) | null = null;
  private cache: Map<string, EmbedCacheEntry> = new Map(); // vaultPath → entry
  private vecs: Map<string, { vec: number[]; file: TFile }> = new Map();
  private indexed = false;
  private indexing = false;
  /** Called every ~5 notes during indexing. speed = newly embedded notes/sec (cached notes excluded). */
  onProgress?: (done: number, total: number, speed: number) => void;
  /** Called during model/WASM download with a human-readable status string. */
  onModelStatus?: (status: string) => void;

  constructor(app: App, modelId: string) {
    this.app = app;
    this.modelId = modelId;
  }

  isIndexed(): boolean { return this.indexed; }

  // ─── Paths ───────────────────────────────────────────────────────────────

  private get vaultRoot(): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.app.vault.adapter as any).basePath as string;
  }

  private get baseDir(): string {
    return join(this.vaultRoot, ".memex-chat");
  }

  private get modelsDir(): string {
    return join(this.baseDir, "models");
  }

  private get embedDir(): string {
    return join(this.baseDir, "embeddings");
  }

  private get manifestPath(): string {
    return join(this.embedDir, ".manifest.json");
  }

  /** Disk path for the embedding of a vault-relative note path (e.g. "folder/note.md") */
  private noteEmbedPath(vaultPath: string): string {
    return join(this.embedDir, vaultPath.replace(/\.md$/, ".ajson"));
  }

  // ─── Pipeline ────────────────────────────────────────────────────────────

  private async loadPipeline(): Promise<void> {
    if (this.pipe) return;

    // Use require() — reliable in CJS bundle; still lazy since we're inside an async function.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { pipeline, env } = require("@xenova/transformers") as any;

    env.backends.onnx.wasm.wasmPaths =
      "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/";
    env.backends.onnx.wasm.proxy = false; // proxy Worker hangs in Obsidian; run inline instead
    env.backends.onnx.wasm.numThreads = 1;
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = false;
    env.useFSCache = true;
    env.cacheDir = this.modelsDir; // store downloaded models in vault's .memex-chat/models/

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const progress_callback = (p: any) => {
      if (!this.onModelStatus) return;
      if (p.status === "initiate") {
        this.onModelStatus(`Lade Modell: ${p.name ?? p.file ?? ""}…`);
      } else if (p.status === "download") {
        const pct = p.progress != null ? ` ${Math.round(p.progress)}%` : "";
        const mb = p.total ? ` (${(p.total / 1e6).toFixed(1)} MB)` : "";
        this.onModelStatus(`Download${pct}${mb}: ${p.file ?? ""}`);
      } else if (p.status === "ready") {
        this.onModelStatus("Modell bereit");
      }
    };

    this.pipe = await pipeline("feature-extraction", this.modelId, {
      quantized: true,
      progress_callback,
    });
  }

  private async embed(text: string): Promise<number[]> {
    await this.loadPipeline();
    const result = await this.pipe!(text.slice(0, 512), { pooling: "mean", normalize: true });
    return Array.from(result.data);
  }

  private cosine(a: number[], b: number[]): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
  }

  // ─── Index ────────────────────────────────────────────────────────────────

  async buildIndex(): Promise<void> {
    if (this.indexing) return;
    this.indexing = true;
    this.indexed = false;
    this.vecs.clear();

    const changed: string[] = []; // vault paths newly embedded this run
    let pipelineError: unknown = null;

    // Create directories unconditionally — independent of pipeline success
    try {
      await fsp.mkdir(this.modelsDir, { recursive: true });
      await fsp.mkdir(this.embedDir, { recursive: true });
    } catch (e) {
      console.error("[Memex] Verzeichnisse konnten nicht angelegt werden:", e);
    }

    try {
      await this.loadCache();

      const files = this.app.vault.getMarkdownFiles();
      const total = files.length;
      let done = 0;
      let windowStart = Date.now();
      let windowEmbedded = 0;
      let speed = 0;

      for (const file of files) {
        const mtime = file.stat.mtime;
        const cached = this.cache.get(file.path);

        if (cached && cached.mtime === mtime) {
          this.vecs.set(file.path, { vec: cached.vec, file });
        } else {
          try {
            // Yield before each inference so Obsidian's event loop can process events
            // (WASM inference is synchronous and blocks the main thread briefly per note)
            await new Promise((r) => setTimeout(r, 0));
            const raw = await this.app.vault.cachedRead(file);
            const text = this.preprocess(raw).slice(0, 800) + " " + file.basename;
            const vec = await this.embed(text);
            this.cache.set(file.path, { mtime, vec });
            this.vecs.set(file.path, { vec, file });
            changed.push(file.path);
            windowEmbedded++;
          } catch (e) {
            if (!this.pipe && !pipelineError) {
              // Pipeline failed to load — log once and abort embedding loop
              pipelineError = e;
              console.error("[Memex] Pipeline-Ladefehler:", e);
              break;
            }
            // skip individual file
          }
        }

        done++;
        if (this.onProgress && done % 5 === 0) {
          const elapsed = (Date.now() - windowStart) / 1000;
          if (elapsed > 0 && windowEmbedded > 0) {
            speed = windowEmbedded / elapsed;
            if (windowEmbedded >= 25) { windowStart = Date.now(); windowEmbedded = 0; }
          }
          this.onProgress(done, total, speed);
        }
      }

      if (pipelineError) throw pipelineError;

      const allPaths = new Set(files.map((f) => f.path));
      await this.saveCache(changed, allPaths);
      this.indexed = true;
      if (this.onProgress) this.onProgress(total, total, speed);
    } finally {
      this.indexing = false;
    }
  }

  async search(query: string, topK = 8): Promise<SearchResult[]> {
    if (!this.indexed) await this.buildIndex();

    const qvec = await this.embed(query);
    const scores: Array<[string, number]> = [];

    for (const [path, { vec }] of this.vecs) {
      const s = this.cosine(qvec, vec);
      if (s > 0.2) scores.push([path, s]);
    }

    scores.sort((a, b) => b[1] - a[1]);
    return scores.slice(0, topK).map(([path, score]) => {
      const { file } = this.vecs.get(path)!;
      return { file, score, excerpt: "", title: file.basename };
    });
  }

  // ─── Cache I/O ───────────────────────────────────────────────────────────

  /**
   * Load all existing .ajson files from embedDir into this.cache.
   * If the manifest model doesn't match, skip loading (full rebuild).
   */
  private async loadCache(): Promise<void> {
    this.cache.clear();
    try {
      const manifestRaw = await fsp.readFile(this.manifestPath, "utf8");
      const manifest: Manifest = JSON.parse(manifestRaw);
      if (manifest.model !== this.modelId) return; // model changed — rebuild all
    } catch {
      return; // no manifest yet — start fresh
    }
    await this.loadCacheDir(this.embedDir);
  }

  private async loadCacheDir(dir: string): Promise<void> {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // skip .manifest.json
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.loadCacheDir(fullPath);
      } else if (entry.name.endsWith(".ajson")) {
        try {
          const raw = await fsp.readFile(fullPath, "utf8");
          const { mtime, vec }: EmbedCacheEntry = JSON.parse(raw);
          // Reconstruct vault path: relative path inside embedDir, swap .ajson → .md
          const rel = relative(this.embedDir, fullPath).replace(/\.ajson$/, ".md");
          // Normalise to forward slashes (vault paths always use /)
          const vaultPath = rel.split("\\").join("/");
          this.cache.set(vaultPath, { mtime, vec });
        } catch {
          // skip corrupt file
        }
      }
    }
  }

  /**
   * Write .ajson for each newly embedded note; delete .ajson for removed notes;
   * write/update the manifest.
   */
  private async saveCache(changed: string[], allVaultPaths: Set<string>): Promise<void> {
    try {
      await fsp.mkdir(this.embedDir, { recursive: true });

      // Manifest
      const manifest: Manifest = { model: this.modelId, version: 1 };
      await fsp.writeFile(this.manifestPath, JSON.stringify(manifest), "utf8");

      // Write only the newly embedded notes
      for (const vaultPath of changed) {
        const entry = this.cache.get(vaultPath);
        if (!entry) continue;
        const filePath = this.noteEmbedPath(vaultPath);
        await fsp.mkdir(dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, JSON.stringify({ mtime: entry.mtime, vec: entry.vec }), "utf8");
      }

      // Prune .ajson files whose notes no longer exist
      await this.pruneStale(this.embedDir, allVaultPaths);
    } catch (e) {
      console.error("[Memex] Embedding-Cache konnte nicht gespeichert werden:", e);
    }
  }

  private async pruneStale(dir: string, allVaultPaths: Set<string>): Promise<void> {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.pruneStale(fullPath, allVaultPaths);
      } else if (entry.name.endsWith(".ajson")) {
        const rel = relative(this.embedDir, fullPath).replace(/\.ajson$/, ".md");
        const vaultPath = rel.split("\\").join("/");
        if (!allVaultPaths.has(vaultPath)) {
          await fsp.unlink(fullPath).catch(() => {});
        }
      }
    }
  }

  // ─── Text preprocessing ──────────────────────────────────────────────────

  private preprocess(raw: string): string {
    let c = raw;
    if (c.startsWith("---")) {
      const end = c.indexOf("\n---", 3);
      if (end > 0) c = c.slice(end + 4);
    }
    c = c.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, a) => a || t);
    c = c.replace(/!\[.*?\]\(.*?\)/g, "");
    c = c.replace(/\[([^\]]+)\]\(.*?\)/g, "$1");
    c = c.replace(/^#{1,6}\s+/gm, "");
    return c;
  }
}
