import { Plugin, WorkspaceLeaf } from "obsidian";
import { ChatView, VIEW_TYPE_MEMEX_CHAT } from "./ChatView";
import { VaultSearch } from "./VaultSearch";
import { ClaudeClient } from "./ClaudeClient";
import { MemexChatSettingsTab, MemexChatSettings, DEFAULT_SETTINGS } from "./SettingsTab";

interface PluginData {
  settings: MemexChatSettings;
  threads: unknown[];
}

export default class MemexChatPlugin extends Plugin {
  settings!: MemexChatSettings;
  search!: VaultSearch;
  claude!: ClaudeClient;
  data!: PluginData;

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

    // Register view
    this.registerView(VIEW_TYPE_MEMEX_CHAT, (leaf) => new ChatView(leaf, this));

    // Ribbon icon
    this.addRibbonIcon("message-circle", "Memex Chat öffnen", () => {
      this.activateView();
    });

    // Commands
    this.addCommand({
      id: "open-memex-chat",
      name: "Memex Chat öffnen",
      callback: () => this.activateView(),
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
    });

    console.log("[Memex Chat] Plugin geladen");
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_MEMEX_CHAT);
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_MEMEX_CHAT);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getLeaf("tab");
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_MEMEX_CHAT, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async rebuildIndex(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MEMEX_CHAT);
    const view = leaves[0]?.view as ChatView | undefined;

    this.search.priorityProperties = this.settings.contextProperties;
    this.search.onProgress = (done, total) => {
      if (view && done % 200 === 0) {
        view.setStatus(`Indiziere… ${done}/${total}`);
      }
    };

    await this.search.buildIndex();
    this.search.onProgress = undefined;
    if (view) {
      view.setStatus(`✓ ${this.app.vault.getMarkdownFiles().length} Notizen indiziert`);
      setTimeout(() => view.setStatus(""), 3000);
    }
  }

  async saveSettings(): Promise<void> {
    this.data.settings = this.settings;
    await this.saveData(this.data);
  }
}
