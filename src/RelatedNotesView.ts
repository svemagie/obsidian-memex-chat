import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type MemexChatPlugin from "./main";

export const VIEW_TYPE_RELATED = "memex-related-notes";

interface MpResult {
  source: string;   // basename without .md
  location: string; // "wing / room"
  score: number;
  excerpt: string;
}

export class RelatedNotesView extends ItemView {
  private plugin: MemexChatPlugin;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: MemexChatPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType()    { return VIEW_TYPE_RELATED; }
  getDisplayText() { return "Verwandte Notizen"; }
  getIcon()        { return "sparkles"; }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleRefresh()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.scheduleRefresh()));
    this.render([], []);
    this.scheduleRefresh();
  }

  private scheduleRefresh(delay = 400) {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), delay);
  }

  onIndexReady() { this.scheduleRefresh(0); }

  private async refresh() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return;

    const es = this.plugin.embedSearch;
    const useMempalace = this.plugin.settings.useMempalace;
    const embedReady = es?.isIndexed() ?? false;

    // Nothing can run yet
    if (!useMempalace && !embedReady) {
      this.renderStatus("Embedding-Index wird aufgebaut…");
      return;
    }

    this.renderStatus("Suche verwandte Notizen…");

    const topK = this.plugin.settings.mempalaceResults ?? 5;
    const modelShort = this.plugin.settings.embeddingModel?.split("/").pop() ?? "Embeddings";

    // Build a richer query from note content (title + stripped body excerpt)
    const mpQuery = await this.buildMpQuery(file);

    const [mpResults, nativeResults] = await Promise.all([
      useMempalace ? this.queryMempalace(mpQuery, topK, file.basename) : Promise.resolve([] as MpResult[]),
      embedReady   ? es!.searchSimilarToFile(file)      : Promise.resolve([]),
    ]);

    this.render(mpResults, nativeResults, file.basename, embedReady ? modelShort : null);
  }

  // ─── MemPalace ────────────────────────────────────────────────────────────

  /** Build a semantic query from the note: title + stripped body (first ~300 chars). */
  private async buildMpQuery(file: TFile): Promise<string> {
    try {
      const raw = await this.app.vault.cachedRead(file);
      // Strip frontmatter
      let body = raw;
      if (body.startsWith("---")) {
        const end = body.indexOf("\n---", 3);
        if (end > 0) body = body.slice(end + 4);
      }
      // Strip wikilinks, markdown syntax
      body = body
        .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, a) => a || t)
        .replace(/!\[.*?\]\(.*?\)/g, "")
        .replace(/\[([^\]]+)\]\(.*?\)/g, "$1")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/[>*_`]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
      return `${file.basename} ${body}`.slice(0, 500).trim();
    } catch {
      return file.basename;
    }
  }

  private async queryMempalace(query: string, topK: number, excludeBasename?: string): Promise<MpResult[]> {
    return new Promise((resolve) => {
      try {
        const { existsSync } = require("fs") as typeof import("fs");
        const { execFile } = require("child_process") as typeof import("child_process");
        if (!existsSync("/usr/local/bin/mempalace")) { resolve([]); return; }
        execFile(
          "/usr/local/bin/mempalace",
          ["search", query, "--results", String(topK + 2)], // fetch extra to absorb self-matches
          { timeout: 8000 },
          (err: Error | null, stdout: string) => {
            if (err || !stdout) { resolve([]); return; }
            const results = this.parseMempalace(stdout)
              .filter((r) => r.source !== excludeBasename)
              .slice(0, topK);
            resolve(results);
          }
        );
      } catch { resolve([]); }
    });
  }

  private parseMempalace(output: string): MpResult[] {
    const results: MpResult[] = [];
    const blocks = output.split(/─{10,}/);
    for (const block of blocks) {
      const locMatch   = block.match(/\[\d+\]\s+(.+?)\n/);
      const srcMatch   = block.match(/Source:\s+(.+?)(?:\.md)?\s*\n/);
      const scoreMatch = block.match(/Match:\s+(-?[\d.]+)/);
      if (!locMatch || !srcMatch || !scoreMatch) continue;

      const location = locMatch[1].trim();
      const source   = srcMatch[1].trim();
      const score    = parseFloat(scoreMatch[1]);
      if (score <= 0) continue; // skip irrelevant results

      const afterScore = block.slice(block.indexOf(scoreMatch[0]) + scoreMatch[0].length).trimStart();
      const excerpt = afterScore.replace(/\n{3,}/g, "\n\n").trim().slice(0, 240);

      results.push({ source, location, score, excerpt });
    }
    return results;
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  private renderStatus(msg: string) {
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: "vc-related-status", text: msg });
  }

  private render(
    mpResults: MpResult[],
    nativeResults: Array<{ file: TFile; score: number; title: string; linked?: boolean }>,
    forNote?: string,
    vaultEngine?: string | null   // model short name, or null if not active
  ) {
    this.contentEl.empty();

    const header = this.contentEl.createDiv("vc-related-header");
    header.createDiv({ cls: "vc-related-title", text: "Verwandte Notizen" });
    if (forNote) header.createDiv({ cls: "vc-related-subtitle", text: forNote });

    if (!mpResults.length && !nativeResults.length) {
      this.contentEl.createDiv({ cls: "vc-related-status", text: forNote ? "Keine Treffer." : "" });
      return;
    }

    // ── MemPalace section ──
    if (mpResults.length) {
      this.contentEl.createDiv({ cls: "vc-related-section-label", text: "MemPalace · semantisch" });
      const mpList = this.contentEl.createDiv("vc-related-list");
      for (const r of mpResults) {
        const item = mpList.createDiv("vc-related-item vc-related-item--mp");

        const info = item.createDiv("vc-related-info");
        const nameRow = info.createDiv("vc-related-name-row");
        nameRow.createSpan({ cls: "vc-related-name", text: r.source });
        nameRow.createSpan({ cls: "vc-related-location", text: r.location });

        if (r.excerpt) {
          info.createDiv({ cls: "vc-related-excerpt", text: r.excerpt });
        }

        const scoreWrap = item.createDiv("vc-related-score-wrap");
        const pct = Math.round(r.score * 100);
        const bar = scoreWrap.createDiv("vc-related-bar");
        bar.createDiv({ cls: "vc-related-bar-fill vc-related-bar-fill--mp" }).style.width = `${pct}%`;
        scoreWrap.createDiv({ cls: "vc-related-pct", text: `${pct}%` });

        item.addEventListener("click", () => {
          const vaultFile = this.app.vault.getMarkdownFiles().find((f) => f.basename === r.source);
          if (vaultFile) this.app.workspace.openLinkText(vaultFile.path, vaultFile.path, false);
        });
      }
    }

    // ── Vault (native) section ──
    if (nativeResults.length) {
      const vaultLabel = vaultEngine ? `Vault · ${vaultEngine}` : "Vault";
      this.contentEl.createDiv({ cls: "vc-related-section-label", text: vaultLabel });
      const list = this.contentEl.createDiv("vc-related-list");
      for (const r of nativeResults) {
        const item = list.createDiv("vc-related-item");

        const info = item.createDiv("vc-related-info");
        const nameRow = info.createDiv("vc-related-name-row");
        nameRow.createSpan({ cls: "vc-related-name", text: r.title });
        if (r.linked) nameRow.createSpan({ cls: "vc-related-linked", text: "verknüpft" });

        const folder = r.file.parent?.path;
        if (folder && folder !== "/") {
          info.createDiv({ cls: "vc-related-folder", text: folder });
        }

        const scoreWrap = item.createDiv("vc-related-score-wrap");
        const pct = Math.round(r.score * 100);
        const bar = scoreWrap.createDiv("vc-related-bar");
        bar.createDiv({ cls: "vc-related-bar-fill" }).style.width = `${pct}%`;
        scoreWrap.createDiv({ cls: "vc-related-pct", text: `${pct}%` });

        item.addEventListener("click", () => {
          this.app.workspace.openLinkText(r.file.path, r.file.path, false);
        });
      }
    }
  }
}
