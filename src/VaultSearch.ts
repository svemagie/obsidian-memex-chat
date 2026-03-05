import { App, TFile } from "obsidian";

export interface SearchResult {
  file: TFile;
  score: number;
  excerpt: string;
  title: string;
  /** True when the note is explicitly linked via a contextProperty frontmatter field */
  linked?: boolean;
}

/** Minimal TF-IDF search engine over the Obsidian vault */
export class VaultSearch {
  private app: App;
  private docVectors: Map<string, Map<string, number>> = new Map(); // path -> term -> tfidf
  private idf: Map<string, number> = new Map();
  private docContents: Map<string, string> = new Map();
  private indexed = false;
  private indexing = false;
  onProgress?: (done: number, total: number) => void;

  /** Frontmatter properties whose values are boosted during indexing */
  priorityProperties: string[] = ["collection", "related", "up", "tags"];
  private readonly propertyBoost = 5; // tokens from priority properties count 5x

  constructor(app: App) {
    this.app = app;
  }

  /** Tokenize text: lowercase, split on non-word chars, keep umlauts */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\wäöüßÄÖÜ\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2);
  }

  /** Strip YAML frontmatter and Obsidian-specific markup */
  private cleanContent(raw: string): string {
    let content = raw;
    // Remove frontmatter
    if (content.startsWith("---")) {
      const end = content.indexOf("\n---", 3);
      if (end > 0) content = content.slice(end + 4);
    }
    // Unwrap wikilinks [[target|alias]] → alias or target
    content = content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => alias || target);
    // Remove markdown images/links
    content = content.replace(/!\[.*?\]\(.*?\)/g, "");
    content = content.replace(/\[([^\]]+)\]\(.*?\)/g, "$1");
    // Remove callout syntax
    content = content.replace(/>\s*\[!\w+\][+-]?\s*/g, "");
    // Remove headers formatting (keep text)
    content = content.replace(/^#{1,6}\s+/gm, "");
    return content;
  }

  /** Build or rebuild the TF-IDF index */
  async buildIndex(): Promise<void> {
    if (this.indexing) return;
    this.indexing = true;
    this.indexed = false;
    this.docVectors.clear();
    this.idf.clear();
    this.docContents.clear();

    try {
      const files = this.app.vault.getMarkdownFiles();
      const total = files.length;
      const df: Map<string, number> = new Map(); // term -> doc count

      // Step 1: Read all files, compute TF
      const tfs: Map<string, Map<string, number>> = new Map();
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (this.onProgress && i % 100 === 0) this.onProgress(i, total);
        try {
          const raw = await this.app.vault.cachedRead(file);
          const clean = this.cleanContent(raw);
          this.docContents.set(file.path, clean);

          const tokens = this.tokenize(clean + " " + file.basename);
          const tf: Map<string, number> = new Map();
          for (const t of tokens) {
            tf.set(t, (tf.get(t) ?? 0) + 1);
          }
          // Boost tokens from priority frontmatter properties
          const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
          for (const prop of this.priorityProperties) {
            const val = fm[prop];
            if (!val) continue;
            const text = Array.isArray(val) ? val.join(" ") : String(val);
            for (const t of this.tokenize(text)) {
              tf.set(t, (tf.get(t) ?? 0) + this.propertyBoost);
            }
          }
          // Normalize TF
          const maxTf = Math.max(...tf.values(), 1);
          const normalizedTf: Map<string, number> = new Map();
          for (const [t, count] of tf) {
            normalizedTf.set(t, count / maxTf);
          }
          tfs.set(file.path, normalizedTf);

          // Update DF
          for (const t of tf.keys()) {
            df.set(t, (df.get(t) ?? 0) + 1);
          }
        } catch {
          // skip unreadable files
        }
      }

      // Step 2: Compute IDF and TF-IDF vectors
      const N = files.length;
      for (const [term, docCount] of df) {
        this.idf.set(term, Math.log(N / docCount + 1));
      }

      for (const [path, tf] of tfs) {
        const vec: Map<string, number> = new Map();
        let norm = 0;
        for (const [term, tfVal] of tf) {
          const idfVal = this.idf.get(term) ?? 0;
          const tfidf = tfVal * idfVal;
          vec.set(term, tfidf);
          norm += tfidf * tfidf;
        }
        // L2 normalize
        norm = Math.sqrt(norm);
        if (norm > 0) {
          for (const [term, val] of vec) {
            vec.set(term, val / norm);
          }
        }
        this.docVectors.set(path, vec);
      }

      this.indexed = true;
      if (this.onProgress) this.onProgress(total, total);
    } finally {
      // Always reset indexing so retries are possible if an error occurred
      this.indexing = false;
    }
  }

  isIndexed(): boolean {
    return this.indexed;
  }

  /** Find notes with similar names (no index required). Uses substring + word-overlap scoring. */
  findSimilarByName(query: string, topK = 2, minScore = 0.45): SearchResult[] {
    const normalize = (s: string) =>
      s.toLowerCase().replace(/[^\wäöüß\s]/gi, " ").trim();
    const words = (s: string) => new Set(s.split(/\s+/).filter((w) => w.length > 1));

    const q = normalize(query);
    const qWords = words(q);

    const scored: Array<[TFile, number]> = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const name = normalize(file.basename);
      const nameWords = words(name);

      let score = 0;
      // Substring containment
      if (name.includes(q) || q.includes(name)) score = 0.9;
      // Jaccard word overlap
      const intersection = [...qWords].filter((w) => nameWords.has(w)).length;
      const union = new Set([...qWords, ...nameWords]).size;
      if (union > 0) score = Math.max(score, intersection / union);

      if (score >= minScore) scored.push([file, score]);
    }

    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, topK).map(([file, score]) => ({
      file,
      score,
      excerpt: "",
      title: file.basename,
    }));
  }

  /** Search for the top-K most similar notes to the query */
  async search(query: string, topK = 8): Promise<SearchResult[]> {
    if (!this.indexed) await this.buildIndex();

    const tokens = this.tokenize(query);
    // Build query TF vector
    const qtf: Map<string, number> = new Map();
    for (const t of tokens) qtf.set(t, (qtf.get(t) ?? 0) + 1);
    const qMax = Math.max(...qtf.values(), 1);

    // Query TF-IDF normalized
    const qvec: Map<string, number> = new Map();
    let qnorm = 0;
    for (const [t, count] of qtf) {
      const tfidf = (count / qMax) * (this.idf.get(t) ?? 0);
      qvec.set(t, tfidf);
      qnorm += tfidf * tfidf;
    }
    qnorm = Math.sqrt(qnorm);
    if (qnorm > 0) for (const [t, v] of qvec) qvec.set(t, v / qnorm);

    // Score all documents
    const scores: Array<[string, number]> = [];
    for (const [path, vec] of this.docVectors) {
      let score = 0;
      for (const [t, qv] of qvec) {
        const dv = vec.get(t) ?? 0;
        score += qv * dv;
      }
      if (score > 0.01) scores.push([path, score]);
    }

    scores.sort((a, b) => b[1] - a[1]);
    const top = scores.slice(0, topK);

    const files = this.app.vault.getMarkdownFiles();
    const fileMap = new Map<string, TFile>(files.map((f) => [f.path, f]));

    return top
      .map(([path, score]) => {
        const file = fileMap.get(path);
        if (!file) return null;
        const content = this.docContents.get(path) ?? "";
        const excerpt = this.buildExcerpt(content, query, 300);
        return { file, score, excerpt, title: file.basename };
      })
      .filter(Boolean) as SearchResult[];
  }

  /** Get note content for context injection */
  async getContent(file: TFile, maxChars = 3000): Promise<string> {
    try {
      const raw = await this.app.vault.cachedRead(file);
      return this.cleanContent(raw).slice(0, maxChars);
    } catch {
      return "";
    }
  }

  private buildExcerpt(content: string, query: string, maxLen: number): string {
    const queryWords = query.toLowerCase().split(/\s+/);
    const lower = content.toLowerCase();
    let bestPos = 0;
    let bestScore = 0;
    for (let i = 0; i < content.length - maxLen; i += 50) {
      const window = lower.slice(i, i + maxLen);
      const score = queryWords.filter((w) => window.includes(w)).length;
      if (score > bestScore) {
        bestScore = score;
        bestPos = i;
      }
    }
    let excerpt = content.slice(bestPos, bestPos + maxLen).trim();
    if (bestPos > 0) excerpt = "…" + excerpt;
    if (bestPos + maxLen < content.length) excerpt += "…";
    return excerpt;
  }
}
