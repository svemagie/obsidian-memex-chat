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
  excludeFolders: string[] = []; // vault folder prefixes to skip
  contextProperties: string[] = []; // frontmatter keys whose links get a score boost
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
    console.log("[Memex] embed: loadPipeline…");
    await this.loadPipeline();
    console.log("[Memex] embed: pipe call…");
    const result = await this.pipe!(text.slice(0, 512), { pooling: "mean", normalize: true });
    console.log("[Memex] embed: done, dims:", result.data.length);
    return Array.from(result.data);
  }

  /** embed() with a hard timeout; rejects with "embed timeout" if exceeded. */
  private embedWithTimeout(text: string, ms = 13000): Promise<number[]> {
    return Promise.race([
      this.embed(text),
      new Promise<number[]>((_, reject) =>
        setTimeout(() => reject(new Error("embed timeout")), ms)
      ),
    ]);
  }

  private cosine(a: number[], b: number[]): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
  }

  // ─── Index ────────────────────────────────────────────────────────────────

  async buildIndex(): Promise<void> {
    console.log("[Memex] buildIndex START, indexing:", this.indexing);
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
      console.log("[Memex] Verzeichnisse OK:", this.embedDir);
    } catch (e) {
      console.error("[Memex] Verzeichnisse konnten nicht angelegt werden:", e);
    }

    try {
      await this.loadCache();
      console.log("[Memex] Cache geladen, Einträge:", this.cache.size);

      const allFiles = this.app.vault.getMarkdownFiles();
      const files = this.excludeFolders.length
        ? allFiles.filter((f) => !this.excludeFolders.some((ex) => f.path.startsWith(ex + "/")))
        : allFiles;
      const total = files.length;
      console.log("[Memex] Dateien gesamt:", total, "(ausgeschlossen:", allFiles.length - total, ")");
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
            // First call initialises WASM + loads model — allow extra time
            const vec = await this.embedWithTimeout(text, this.pipe ? 13000 : 120000);
            this.cache.set(file.path, { mtime, vec });
            this.vecs.set(file.path, { vec, file });
            changed.push(file.path);
            windowEmbedded++;
            if (changed.length === 1 || changed.length % 50 === 0)
              console.log(`[Memex] Eingebettet: ${changed.length}/${total}`);
            // Flush newly embedded notes to disk every 100 to preserve progress
            if (changed.length % 100 === 0) await this.flushBatch(changed.slice(-100));
          } catch (e) {
            if (!this.pipe && !pipelineError) {
              // Pipeline failed to load — log once and abort embedding loop
              pipelineError = e;
              console.error("[Memex] Pipeline-Ladefehler:", e);
              break;
            }
            console.warn("[Memex] Datei übersprungen:", file.path, e);
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

      console.log("[Memex] Loop fertig, changed:", changed.length, "pipelineError:", !!pipelineError);
      if (pipelineError) throw pipelineError;

      const allPaths = new Set(files.map((f) => f.path));
      // Flush remainder (notes not yet flushed by the every-100 batches)
      const remainder = changed.length % 100;
      await this.saveCache(remainder > 0 ? changed.slice(-remainder) : [], allPaths);
      this.indexed = true;
      if (this.onProgress) this.onProgress(total, total, speed);
    } catch (e) {
      console.error("[Memex] buildIndex Fehler:", e);
    } finally {
      this.indexing = false;
      console.log("[Memex] buildIndex END, indexed:", this.indexed);
    }
  }

  // ─── Incremental re-embed on file change ─────────────────────────────────

  private reembedTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /**
   * Debounced re-embed for a single file (called on vault modify events).
   * Waits 2 s after the last write before embedding.
   */
  reembedFile(file: TFile): void {
    if (!this.indexed || this.indexing) return;
    const existing = this.reembedTimers.get(file.path);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(async () => {
      this.reembedTimers.delete(file.path);
      try {
        const raw = await this.app.vault.cachedRead(file);
        const text = this.preprocess(raw).slice(0, 800) + " " + file.basename;
        const vec = await this.embedWithTimeout(text);
        const mtime = file.stat.mtime;
        this.cache.set(file.path, { mtime, vec });
        this.vecs.set(file.path, { vec, file });
        await this.saveCache([file.path], new Set(this.vecs.keys()));
        console.log("[Memex] Re-embedded:", file.path);
      } catch (e) {
        console.warn("[Memex] Re-embed fehlgeschlagen:", file.path, e);
      }
    }, 2000);
    this.reembedTimers.set(file.path, timer);
  }

  /** Find notes similar to a given file using its cached vector (no re-embedding). */
  async searchSimilarToFile(file: TFile, topK = 10): Promise<SearchResult[]> {
    if (!this.indexed) return [];
    let qvec = this.vecs.get(file.path)?.vec;
    if (!qvec) {
      // File not yet indexed — embed on the fly
      try {
        const raw = await this.app.vault.cachedRead(file);
        const text = this.preprocess(raw).slice(0, 800) + " " + file.basename;
        qvec = await this.embedWithTimeout(text);
      } catch { return []; }
    }

    // Collect paths explicitly linked via contextProperty frontmatter fields
    const linkedPaths = new Set<string>();
    if (this.contextProperties.length > 0) {
      const meta = this.app.metadataCache.getFileCache(file);
      const links = meta?.frontmatterLinks ?? [];
      for (const link of links) {
        if (this.contextProperties.includes(link.key.split(".")[0])) {
          const resolved = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
          if (resolved) linkedPaths.add(resolved.path);
        }
      }
    }

    // Collect tags of the current file
    const fileMeta = this.app.metadataCache.getFileCache(file);
    const fileTags = new Set<string>(
      (fileMeta?.tags ?? []).map((t) => t.tag.toLowerCase())
    );

    const scores: Array<[string, number]> = [];
    for (const [path, { vec }] of this.vecs) {
      if (path === file.path) continue;
      let s = this.cosine(qvec, vec);
      if (s < 0.15) continue; // broader pre-filter to allow boosted notes through

      if (linkedPaths.has(path)) {
        s = Math.min(1.0, s + 0.15);
      }

      if (fileTags.size > 0) {
        const otherMeta = this.app.metadataCache.getFileCache(this.vecs.get(path)!.file);
        const otherTags = (otherMeta?.tags ?? []).map((t) => t.tag.toLowerCase());
        let sharedTags = 0;
        for (const tag of otherTags) {
          if (fileTags.has(tag)) sharedTags++;
          if (sharedTags >= 3) break;
        }
        if (sharedTags > 0) s = Math.min(1.0, s + sharedTags * 0.05);
      }

      scores.push([path, s]);
    }
    scores.sort((a, b) => b[1] - a[1]);
    return scores.slice(0, topK).map(([path, score]) => {
      const { file: f } = this.vecs.get(path)!;
      return { file: f, score, excerpt: "", title: f.basename, linked: linkedPaths.has(path) };
    });
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

  /** Write .ajson files for a batch of vault paths (no pruning). Called incrementally. */
  private async flushBatch(vaultPaths: string[]): Promise<void> {
    try {
      const manifest: Manifest = { model: this.modelId, version: 1 };
      await fsp.writeFile(this.manifestPath, JSON.stringify(manifest), "utf8");
      for (const vaultPath of vaultPaths) {
        const entry = this.cache.get(vaultPath);
        if (!entry) continue;
        const filePath = this.noteEmbedPath(vaultPath);
        await fsp.mkdir(dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, JSON.stringify({ mtime: entry.mtime, vec: entry.vec }), "utf8");
      }
    } catch (e) {
      console.error("[Memex] flushBatch Fehler:", e);
    }
  }

  /**
   * Final save: flush any remaining changed notes, then prune stale .ajson files.
   */
  private async saveCache(changed: string[], allVaultPaths: Set<string>): Promise<void> {
    if (changed.length > 0) await this.flushBatch(changed);
    await this.pruneStale(this.embedDir, allVaultPaths);
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
