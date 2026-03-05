import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type MemexChatPlugin from "./main";

export const VIEW_TYPE_RELATED = "memex-related-notes";

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
    this.render([]);
    this.scheduleRefresh();
  }

  private scheduleRefresh(delay = 400) {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), delay);
  }

  /** Called by the plugin when the embedding index finishes building. */
  onIndexReady() { this.scheduleRefresh(0); }

  private async refresh() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return;

    const es = this.plugin.embedSearch;
    if (!es || !es.isIndexed()) {
      this.renderStatus("Embedding-Index wird aufgebaut…");
      return;
    }

    this.renderStatus("Suche verwandte Notizen…");
    const results = await es.searchSimilarToFile(file);
    this.render(results, file.basename);
  }

  private renderStatus(msg: string) {
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: "vc-related-status", text: msg });
  }

  private render(results: Array<{ file: TFile; score: number; title: string }>, forNote?: string) {
    this.contentEl.empty();

    const header = this.contentEl.createDiv("vc-related-header");
    header.createDiv({ cls: "vc-related-title", text: "Verwandte Notizen" });
    if (forNote) header.createDiv({ cls: "vc-related-subtitle", text: forNote });

    if (!results.length) {
      this.contentEl.createDiv({ cls: "vc-related-status", text: forNote ? "Keine Treffer." : "" });
      return;
    }

    const list = this.contentEl.createDiv("vc-related-list");
    for (const r of results) {
      const item = list.createDiv("vc-related-item");

      const info = item.createDiv("vc-related-info");
      const nameRow = info.createDiv("vc-related-name-row");
      nameRow.createSpan({ cls: "vc-related-name", text: r.title });
      if (r.linked) nameRow.createSpan({ cls: "vc-related-linked", text: "verknüpft" });

      // Folder path (dimmed)
      const folder = r.file.parent?.path;
      if (folder && folder !== "/") {
        info.createDiv({ cls: "vc-related-folder", text: folder });
      }

      // Similarity bar + percentage
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
