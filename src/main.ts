import { Notice, Plugin, TFile } from "obsidian";
import { ChatView, VIEW_TYPE_MEMEX_CHAT } from "./ChatView";
import { VaultSearch } from "./VaultSearch";
import { EmbedSearch } from "./EmbedSearch";
import { ClaudeClient } from "./ClaudeClient";
import { MemexChatSettingsTab, MemexChatSettings, DEFAULT_SETTINGS } from "./SettingsTab";
import { RelatedNotesView, VIEW_TYPE_RELATED } from "./RelatedNotesView";

interface PluginData {
  settings: MemexChatSettings;
  threads: unknown[];
}

export default class MemexChatPlugin extends Plugin {
  settings!: MemexChatSettings;
  search!: VaultSearch;
  embedSearch: EmbedSearch | null = null;
  claude!: ClaudeClient;
  data!: PluginData;

  /** Returns the active search engine: EmbedSearch when enabled, else VaultSearch */
  get activeSearch(): VaultSearch | EmbedSearch {
    return this.embedSearch ?? this.search;
  }

  async onload(): Promise<void> {
    // Load data
    const loaded = (await this.loadData()) as PluginData | null;
    const mergedSettings: MemexChatSettings = { ...DEFAULT_SETTINGS, ...(loaded?.settings ?? {}) };
    // Merge promptButtons per-entry so new fields (e.g. helpText) from defaults aren't lost
    if (loaded?.settings?.promptButtons) {
      mergedSettings.promptButtons = loaded.settings.promptButtons.map((saved, i) => ({
        ...(DEFAULT_SETTINGS.promptButtons[i] ?? {}),
        ...saved,
      }));
    }
    this.data = {
      settings: mergedSettings,
      threads: loaded?.threads ?? [],
    };
    this.settings = this.data.settings;

    // Init services
    this.search = new VaultSearch(this.app);
    this.claude = new ClaudeClient();

    // Register views
    this.registerView(VIEW_TYPE_MEMEX_CHAT, (leaf) => new ChatView(leaf, this));
    this.registerView(VIEW_TYPE_RELATED, (leaf) => new RelatedNotesView(leaf, this));

    // Ribbon icons
    this.addRibbonIcon("message-circle", "Memex Chat öffnen", () => {
      this.activateView();
    });
    this.addRibbonIcon("sparkles", "Verwandte Notizen", () => {
      this.activateRelatedView();
    });

    // Commands
    this.addCommand({
      id: "open-memex-chat",
      name: "Memex Chat öffnen",
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "memex-related-notes",
      name: "Verwandte Notizen anzeigen",
      callback: () => this.activateRelatedView(),
    });

    this.addCommand({
      id: "memex-chat-rebuild-index",
      name: "Memex Chat: Index neu aufbauen",
      callback: () => this.rebuildIndex(),
    });

    this.addCommand({
      id: "memex-chat-active-note",
      name: "Memex Chat: Aktive Notiz als Kontext",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file) {
          this.activateView().then(() => {
            // Pre-fill with active note path
            const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_MEMEX_CHAT)[0];
            if (leaf) {
              const view = leaf.view as ChatView;
              view.setInputValue(`Erkläre und verknüpfe [[${file.basename}]] mit anderen Konzepten im Vault.`);
              view.setExplicitContext([file]);
            }
          });
        }
      },
    });

    // Settings tab
    this.addSettingTab(new MemexChatSettingsTab(this.app, this));

    // Build index once the workspace layout (and vault cache) is fully ready
    this.app.workspace.onLayoutReady(() => {
      if (!this.search.isIndexed()) {
        this.search.priorityProperties = this.settings.contextProperties;
        this.search.buildIndex().catch(console.error);
      }
      if (this.settings.useEmbeddings) {
        this.initEmbedSearch().catch(console.error);
      }
    });
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_MEMEX_CHAT);
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_MEMEX_CHAT);
    if (existing.length > 0) { this.app.workspace.revealLeaf(existing[0]); return; }
    const leaf = this.app.workspace.getLeaf("tab");
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_MEMEX_CHAT, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async activateRelatedView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_RELATED);
    if (existing.length > 0) { this.app.workspace.revealLeaf(existing[0]); return; }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_RELATED, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private notifyRelatedView() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_RELATED).forEach((l) => {
      if (l.view instanceof RelatedNotesView) l.view.onIndexReady();
    });
  }

  /** Create or recreate the EmbedSearch instance (called when settings change) */
  async initEmbedSearch(): Promise<void> {
    if (!this.settings.useEmbeddings) {
      this.embedSearch = null;
      return;
    }
    this.embedSearch = new EmbedSearch(this.app, this.settings.embeddingModel);
    this.embedSearch.excludeFolders = this.settings.embedExcludeFolders ?? [];
    this.embedSearch.contextProperties = this.settings.contextProperties ?? [];

    // Re-embed modified notes as they change
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.embedSearch && file instanceof TFile && file.extension === "md")
          this.embedSearch.reembedFile(file);
      })
    );

    // Persistent notice updated during background indexing
    const notice = new Notice("Memex: Embedding wird vorbereitet…", 0);

    this.embedSearch.onModelStatus = (status) => {
      notice.setMessage(`Memex: ${status}`);
    };

    this.embedSearch.onProgress = (done, total, speed) => {
      const speedStr = speed > 0 ? ` • ${speed.toFixed(1)} N/s` : "";
      const remaining = speed > 0 && done < total ? (total - done) / speed : 0;
      const eta = remaining > 0
        ? ` • ~${remaining < 60 ? Math.ceil(remaining) + "s" : Math.ceil(remaining / 60) + "min"}`
        : "";
      notice.setMessage(`Memex Embedding: ${done}/${total}${speedStr}${eta}`);
    };

    // Wait for Obsidian Sync to finish before starting (avoids embedding stale/partial files)
    this.waitForSyncIdle(notice).then(() => this.embedSearch?.buildIndex())
      .then(() => {
        notice.setMessage(`✓ Memex: ${this.app.vault.getMarkdownFiles().length} Notizen eingebettet`);
        setTimeout(() => notice.hide(), 4000);
        this.notifyRelatedView();
      })
      .catch((e) => {
        notice.setMessage(`✗ Memex Embedding: ${(e as Error).message}`);
        setTimeout(() => notice.hide(), 6000);
        console.error(e);
      })
      .finally(() => {
        if (this.embedSearch) {
          this.embedSearch.onProgress = undefined;
          this.embedSearch.onModelStatus = undefined;
        }
      });
  }

  async rebuildIndex(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MEMEX_CHAT);
    const view = leaves[0]?.view as ChatView | undefined;

    if (this.settings.useEmbeddings && this.embedSearch) {
      // Rebuild semantic (embedding) index
      this.embedSearch.onModelStatus = (status) => {
        if (view) view.setStatus(status);
      };
      this.embedSearch.onProgress = (done, total, speed) => {
        if (view) {
          const speedStr = speed > 0 ? ` • ${speed.toFixed(1)} N/s` : "";
          const eta = speed > 0 && done < total
            ? ` • noch ~${Math.ceil((total - done) / speed)}s`
            : "";
          view.setStatus(`Embedding ${done}/${total}${speedStr}${eta}`);
        }
      };
      await this.embedSearch.buildIndex();
      this.embedSearch.onProgress = undefined;
      this.embedSearch.onModelStatus = undefined;
    } else {
      // Rebuild TF-IDF index
      this.search.priorityProperties = this.settings.contextProperties;
      this.search.onProgress = (done, total) => {
        if (view && done % 200 === 0) {
          view.setStatus(`Indiziere… ${done}/${total}`);
        }
      };
      await this.search.buildIndex();
      this.search.onProgress = undefined;
    }

    if (view) {
      view.setStatus(`✓ ${this.app.vault.getMarkdownFiles().length} Notizen indiziert`);
      setTimeout(() => view.setStatus(""), 3000);
    }
  }

  /**
   * Waits until Obsidian Sync is idle.
   * Strategy: watch for vault changes; if activity stops for 15 s, sync is done.
   * If no activity within the first 5 s, sync isn't running — return immediately.
   * Falls back after 5 minutes regardless.
   */
  private async waitForSyncIdle(notice: Notice): Promise<void> {
    // Only wait if the Sync plugin is installed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const syncPlugin = (this.app as any).internalPlugins?.plugins?.["sync"]?.instance;
    if (!syncPlugin) return;

    const PROBE_MS   = 5_000;  // time to detect if sync is active
    const QUIET_MS   = 15_000; // idle period that signals sync completion
    const MAX_MS     = 5 * 60_000;

    let lastChange = 0;
    let activitySeen = false;
    const tick = () => { lastChange = Date.now(); activitySeen = true; };

    this.app.vault.on("create", tick);
    this.app.vault.on("modify", tick);
    this.app.vault.on("delete", tick);

    try {
      notice.setMessage("Memex: Prüfe Sync-Status…");
      await new Promise((r) => setTimeout(r, PROBE_MS));
      if (!activitySeen) return; // no sync activity → proceed immediately

      notice.setMessage("Memex: Warte auf Obsidian Sync…");
      const deadline = Date.now() + MAX_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2_000));
        if (Date.now() - lastChange >= QUIET_MS) return; // 15 s quiet → done
      }
      // Max wait reached — proceed anyway
    } finally {
      this.app.vault.off("create", tick);
      this.app.vault.off("modify", tick);
      this.app.vault.off("delete", tick);
    }
  }

  async saveSettings(): Promise<void> {
    this.data.settings = this.settings;
    await this.saveData(this.data);
  }
}
