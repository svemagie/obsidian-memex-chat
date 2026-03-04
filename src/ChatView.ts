import { ItemView, WorkspaceLeaf, TFile, MarkdownRenderer, Component } from "obsidian";
import type MemexChatPlugin from "./main";
import { SearchResult } from "./VaultSearch";
import { ClaudeMessage } from "./ClaudeClient";

export const VIEW_TYPE_MEMEX_CHAT = "memex-chat-view";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  contextNotes?: string[]; // paths of notes used
  isStreaming?: boolean;
}

interface Thread {
  id: string;
  title: string;
  messages: ChatMessage[];
  created: number;
  updated: number;
}

export class ChatView extends ItemView {
  plugin: MemexChatPlugin;
  private threads: Thread[] = [];
  private activeThreadId: string | null = null;
  private pendingContext: SearchResult[] = [];
  private explicitContext: TFile[] = [];
  private isLoading = false;
  private renderComponent: Component;

  // DOM refs
  private threadListEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private contextPreviewEl!: HTMLElement;
  private sendBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private mentionDropdownEl!: HTMLElement;

  // Mention autocomplete state
  private mentionSelectedIdx = 0;
  private mentionMatches: string[] = [];

  constructor(leaf: WorkspaceLeaf, plugin: MemexChatPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.renderComponent = new Component();
  }

  getViewType(): string {
    return VIEW_TYPE_MEMEX_CHAT;
  }

  getDisplayText(): string {
    return "Memex Chat";
  }

  getIcon(): string {
    return "message-circle";
  }

  async onOpen(): Promise<void> {
    this.renderComponent.load();
    this.loadThreads();
    this.buildUI();
    if (!this.activeThreadId && this.threads.length === 0) {
      this.newThread();
    } else if (!this.activeThreadId && this.threads.length > 0) {
      this.switchThread(this.threads[0].id);
    }
  }

  async onClose(): Promise<void> {
    this.renderComponent.unload();
    this.saveThreads();
  }

  // ─── UI Construction ─────────────────────────────────────────────────────

  private buildUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("vc-root");

    // Header
    const header = root.createDiv("vc-header");
    header.createEl("span", { text: "Memex Chat", cls: "vc-header-title" });
    const headerActions = header.createDiv("vc-header-actions");

    const newThreadBtn = headerActions.createEl("button", { cls: "vc-icon-btn", title: "Neuer Thread" });
    newThreadBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none"><path d="M12 5v14M5 12h14" stroke-width="2" stroke-linecap="round"/></svg>`;
    newThreadBtn.onclick = () => this.newThread();

    const rebuildBtn = headerActions.createEl("button", { cls: "vc-icon-btn", title: "Index neu aufbauen" });
    rebuildBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none"><path d="M4 4v5h5M20 20v-5h-5" stroke-width="2" stroke-linecap="round"/><path d="M4.07 9a8 8 0 0 1 14.72-1.65M19.93 15a8 8 0 0 1-14.72 1.65" stroke-width="2" stroke-linecap="round"/></svg>`;
    rebuildBtn.onclick = async () => {
      rebuildBtn.disabled = true;
      this.setStatus("Indiziere Vault…");
      await this.plugin.rebuildIndex();
      this.setStatus(`✓ ${this.plugin.search.isIndexed() ? "Index bereit" : ""}`);
      setTimeout(() => this.setStatus(""), 2000);
      rebuildBtn.disabled = false;
    };

    const main = root.createDiv("vc-main");

    // Thread sidebar
    const sidebar = main.createDiv("vc-sidebar");
    sidebar.createEl("div", { text: "Threads", cls: "vc-sidebar-title" });
    this.threadListEl = sidebar.createDiv("vc-thread-list");

    // Chat area
    const chatArea = main.createDiv("vc-chat-area");

    // Status bar
    this.statusEl = chatArea.createDiv("vc-status");

    // Messages
    this.messagesEl = chatArea.createDiv("vc-messages");

    // Context preview
    this.contextPreviewEl = chatArea.createDiv("vc-context-preview");
    this.contextPreviewEl.style.display = "none";

    // Input area
    const inputArea = chatArea.createDiv("vc-input-area");

    const inputWrapper = inputArea.createDiv("vc-input-wrapper");
    this.mentionDropdownEl = inputWrapper.createDiv("vc-mention-dropdown");
    this.mentionDropdownEl.style.display = "none";
    this.inputEl = inputWrapper.createEl("textarea", {
      cls: "vc-input",
      attr: { placeholder: "Frage stellen… (@ für Notiz einfügen)" },
    });
    this.inputEl.rows = 3;

    const inputActions = inputArea.createDiv("vc-input-actions");

    const contextBtn = inputActions.createEl("button", { cls: "vc-ctx-btn", title: "Kontext manuell auswählen" });
    contextBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" stroke-width="2"/><path d="M14 2v6h6M8 13h8M8 17h5" stroke-width="2" stroke-linecap="round"/></svg> Kontext`;
    contextBtn.onclick = () => this.openContextPicker();

    this.sendBtn = inputActions.createEl("button", { cls: "vc-send-btn" });
    this.sendBtn.setText("Senden");
    this.sendBtn.onclick = () => this.handleSend();

    // Key bindings
    this.inputEl.addEventListener("keydown", (e) => {
      if (this.mentionDropdownEl.style.display !== "none") {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.moveMentionSelection(1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          this.moveMentionSelection(-1);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          this.confirmMentionSelection();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this.hideMentionDropdown();
          return;
        }
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.handleSend();
      }
    });

    this.inputEl.addEventListener("input", () => this.handleInputChange());

    this.renderThreadList();
  }

  // ─── Thread Management ────────────────────────────────────────────────────

  private newThread(): void {
    const thread: Thread = {
      id: Date.now().toString(),
      title: "Neuer Chat",
      messages: [],
      created: Date.now(),
      updated: Date.now(),
    };
    this.threads.unshift(thread);
    this.switchThread(thread.id);
    this.saveThreads();
  }

  private switchThread(id: string): void {
    this.saveThreads();
    this.activeThreadId = id;
    this.renderThreadList();
    this.renderMessages();
    this.clearContextPreview();
  }

  private get activeThread(): Thread | undefined {
    return this.threads.find((t) => t.id === this.activeThreadId);
  }

  private deleteThread(id: string): void {
    this.threads = this.threads.filter((t) => t.id !== id);
    if (this.activeThreadId === id) {
      if (this.threads.length > 0) this.switchThread(this.threads[0].id);
      else this.newThread();
    }
    this.saveThreads();
    this.renderThreadList();
  }

  // ─── Send & Context ──────────────────────────────────────────────────────

  private async handleSend(): Promise<void> {
    const query = this.inputEl.value.trim();
    if (!query || this.isLoading) return;

    if (!this.plugin.settings.apiKey) {
      this.setStatus("⚠ Bitte API Key in den Einstellungen eingeben");
      return;
    }

    // Parse @[[mentions]] from input
    const mentionPattern = /\[\[([^\]]+)\]\]/g;
    const mentions: TFile[] = [];
    let match;
    while ((match = mentionPattern.exec(query)) !== null) {
      const name = match[1];
      const file = this.app.metadataCache.getFirstLinkpathDest(name, "");
      if (file) mentions.push(file);
    }

    // If context preview is enabled and auto-retrieve is on, fetch context first
    if (this.plugin.settings.autoRetrieveContext && this.plugin.settings.showContextPreview) {
      if (this.pendingContext.length === 0 && this.explicitContext.length === 0) {
        await this.fetchAndShowContext(query, mentions);
        return; // wait for user to confirm/modify context
      }
    }

    await this.sendMessage(query, mentions);
  }

  private async fetchAndShowContext(query: string, mentions: TFile[]): Promise<void> {
    this.setStatus("Suche relevante Notizen…");
    this.isLoading = true;
    try {
      if (!this.plugin.search.isIndexed()) {
        this.setStatus("Indiziere Vault…");
        await this.plugin.search.buildIndex();
      }
      this.pendingContext = await this.plugin.search.search(query, this.plugin.settings.maxContextNotes);
      this.explicitContext = mentions;
      this.renderContextPreview();
      this.setStatus("Kontext bereit — Senden bestätigen oder anpassen");
    } catch (e) {
      this.setStatus("Fehler bei Kontextsuche: " + e.message);
    }
    this.isLoading = false;
  }

  private async sendMessage(query: string, additionalFiles: TFile[] = []): Promise<void> {
    this.isLoading = true;
    this.sendBtn.disabled = true;

    const thread = this.activeThread;
    if (!thread) return;

    // Build context
    const contextFiles: TFile[] = [
      ...this.explicitContext,
      ...this.pendingContext.map((r) => r.file),
      ...additionalFiles,
    ].filter((f, i, arr) => arr.findIndex((x) => x.path === f.path) === i);

    const contextNotes = contextFiles.map((f) => f.path);

    // Build context text
    let contextText = "";
    if (contextFiles.length > 0) {
      this.setStatus(`Lade ${contextFiles.length} Notizen…`);
      const contents = await Promise.all(
        contextFiles.map(async (f) => {
          const content = await this.plugin.search.getContent(f, this.plugin.settings.maxCharsPerNote);
          return `=== [[${f.basename}]] ===\n${content}`;
        })
      );
      contextText = "\n\n---\nKontext aus dem Vault:\n\n" + contents.join("\n\n");
    }

    // Add user message
    const userMsg: ChatMessage = {
      role: "user",
      content: query,
      timestamp: Date.now(),
      contextNotes,
    };
    thread.messages.push(userMsg);
    thread.updated = Date.now();
    if (thread.messages.length === 1) {
      thread.title = query.slice(0, 50) + (query.length > 50 ? "…" : "");
    }

    // Clear input and context
    this.inputEl.value = "";
    this.pendingContext = [];
    this.explicitContext = [];
    this.clearContextPreview();
    this.renderMessages();
    this.renderThreadList();

    // Add streaming assistant message
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
    };
    thread.messages.push(assistantMsg);
    this.renderMessages();

    // Build Claude messages (history)
    const claudeMessages: ClaudeMessage[] = thread.messages
      .slice(0, -1) // exclude the empty assistant msg we just added
      .map((m) => ({
        role: m.role,
        content: m.content,
      }));

    // Add user message with context
    claudeMessages.push({
      role: "user",
      content: query + contextText,
    });

    this.setStatus("Claude denkt…");

    try {
      const stream = this.plugin.claude.streamChat(claudeMessages, {
        apiKey: this.plugin.settings.apiKey,
        model: this.plugin.settings.model,
        systemPrompt: this.plugin.settings.systemPrompt,
      });

      for await (const chunk of stream) {
        if (chunk.type === "text" && chunk.text) {
          assistantMsg.content += chunk.text;
          this.updateLastMessage(assistantMsg.content);
        } else if (chunk.type === "error") {
          assistantMsg.content = `❌ Fehler: ${chunk.error}`;
          this.updateLastMessage(assistantMsg.content);
          break;
        }
      }

      assistantMsg.isStreaming = false;
      assistantMsg.contextNotes = contextNotes;
      this.setStatus("");
      this.renderMessages(); // final render with sources
      this.saveThreads();
      if (this.plugin.settings.saveThreadsToVault) {
        await this.saveThreadToVault(thread);
      }
    } catch (e) {
      assistantMsg.content = `❌ Fehler: ${e.message}`;
      assistantMsg.isStreaming = false;
      this.renderMessages();
      this.setStatus("");
    }

    this.isLoading = false;
    this.sendBtn.disabled = false;
    this.scrollToBottom();
  }

  // ─── Context Preview ──────────────────────────────────────────────────────

  private renderContextPreview(): void {
    this.contextPreviewEl.empty();
    this.contextPreviewEl.style.display = "block";

    const header = this.contextPreviewEl.createDiv("vc-ctx-header");
    header.createEl("span", { text: `📎 Kontext (${this.pendingContext.length} Notizen)`, cls: "vc-ctx-title" });

    const actions = header.createDiv("vc-ctx-actions");
    const confirmBtn = actions.createEl("button", { cls: "vc-send-btn vc-send-btn--sm", text: "✓ Senden" });
    confirmBtn.onclick = () => this.sendMessage(this.inputEl.value.trim());

    const clearBtn = actions.createEl("button", { cls: "vc-ctx-btn", text: "✗ Ohne Kontext" });
    clearBtn.onclick = () => {
      this.pendingContext = [];
      this.explicitContext = [];
      this.clearContextPreview();
      this.sendMessage(this.inputEl.value.trim());
    };

    const list = this.contextPreviewEl.createDiv("vc-ctx-list");
    for (const result of this.pendingContext) {
      const item = list.createDiv("vc-ctx-item");
      const score = Math.round(result.score * 100);

      const itemHeader = item.createDiv("vc-ctx-item-header");
      const titleEl = itemHeader.createEl("span", { text: result.title, cls: "vc-ctx-item-title" });
      titleEl.onclick = () => this.app.workspace.openLinkText(result.file.path, "", false);

      itemHeader.createEl("span", { text: `${score}%`, cls: "vc-ctx-score" });

      const removeBtn = itemHeader.createEl("button", { cls: "vc-icon-btn vc-ctx-remove", title: "Entfernen" });
      removeBtn.innerHTML = `✕`;
      removeBtn.onclick = () => {
        this.pendingContext = this.pendingContext.filter((r) => r.file.path !== result.file.path);
        this.renderContextPreview();
      };

      const excerpt = item.createDiv("vc-ctx-excerpt");
      excerpt.setText(result.excerpt.slice(0, 120) + "…");
    }
  }

  private clearContextPreview(): void {
    this.contextPreviewEl.style.display = "none";
    this.contextPreviewEl.empty();
    this.pendingContext = [];
    this.explicitContext = [];
    this.setStatus("");
  }

  private async openContextPicker(): Promise<void> {
    const lastUserMsg = [...(this.activeThread?.messages ?? [])]
      .reverse()
      .find((m) => m.role === "user")?.content ?? "";
    const query = this.inputEl.value.trim() || lastUserMsg;
    this.setStatus("Suche Notizen…");
    try {
      if (!this.plugin.search.isIndexed()) await this.plugin.search.buildIndex();
      const results = await this.plugin.search.search(query, this.plugin.settings.maxContextNotes);
      this.pendingContext = results;
      this.renderContextPreview();
      this.setStatus("");
    } catch (e) {
      this.setStatus("Fehler: " + e.message);
    }
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  private renderThreadList(): void {
    this.threadListEl.empty();
    for (const thread of this.threads) {
      const item = this.threadListEl.createDiv("vc-thread-item" + (thread.id === this.activeThreadId ? " vc-thread-item--active" : ""));
      const titleEl = item.createEl("span", { text: thread.title, cls: "vc-thread-title" });
      titleEl.onclick = () => this.switchThread(thread.id);

      const del = item.createEl("button", { cls: "vc-icon-btn vc-thread-del", title: "Löschen" });
      del.innerHTML = "✕";
      del.onclick = (e) => {
        e.stopPropagation();
        this.deleteThread(thread.id);
      };
    }
  }

  private renderMessages(): void {
    this.messagesEl.empty();
    const thread = this.activeThread;
    if (!thread || thread.messages.length === 0) {
      const empty = this.messagesEl.createDiv("vc-empty");
      empty.createEl("div", { text: "💬", cls: "vc-empty-icon" });
      empty.createEl("div", { text: "Stell eine Frage — ich suche passende Notizen aus deinem Vault.", cls: "vc-empty-text" });
      empty.createEl("div", { text: "Tipp: Nutze @[[Notizname]] um eine Notiz direkt einzubinden.", cls: "vc-empty-hint" });
      return;
    }

    for (const msg of thread.messages) {
      this.renderMessage(msg);
    }
    this.scrollToBottom();
  }

  private renderMessage(msg: ChatMessage): void {
    const msgEl = this.messagesEl.createDiv(`vc-msg vc-msg--${msg.role}`);

    const bubble = msgEl.createDiv("vc-bubble");

    if (msg.role === "user") {
      bubble.setText(msg.content);
    } else {
      // Render markdown for assistant
      const mdEl = bubble.createDiv("vc-md");
      if (msg.isStreaming) {
        mdEl.setText(msg.content);
        mdEl.createEl("span", { cls: "vc-cursor", text: "█" });
      } else {
        MarkdownRenderer.render(this.app, msg.content, mdEl, "", this.renderComponent);
      }
    }

    // Show context sources
    if (!msg.isStreaming && msg.contextNotes && msg.contextNotes.length > 0) {
      const sources = msgEl.createDiv("vc-sources");
      sources.createEl("span", { text: "Quellen: ", cls: "vc-sources-label" });
      for (const notePath of msg.contextNotes) {
        const file = this.app.vault.getAbstractFileByPath(notePath);
        const name = file instanceof TFile ? file.basename : notePath.split("/").pop() ?? notePath;
        const link = sources.createEl("span", { text: `[[${name}]]`, cls: "vc-source-link" });
        link.onclick = () => this.app.workspace.openLinkText(notePath, "", false);
      }
    }
  }

  private updateLastMessage(content: string): void {
    const messages = this.messagesEl.querySelectorAll(".vc-msg--assistant");
    const last = messages[messages.length - 1];
    if (!last) return;
    const mdEl = last.querySelector(".vc-md");
    if (mdEl) {
      mdEl.textContent = content;
      const cursor = mdEl.querySelector(".vc-cursor");
      if (!cursor) mdEl.createEl("span", { cls: "vc-cursor", text: "█" });
    }
    this.scrollToBottom();
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private setStatus(text: string): void {
    this.statusEl.setText(text);
    this.statusEl.style.display = text ? "block" : "none";
  }

  private handleInputChange(): void {
    // Auto-resize textarea
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 200) + "px";

    // @mention autocomplete
    const cursor = this.inputEl.selectionStart ?? 0;
    const textBefore = this.inputEl.value.slice(0, cursor);
    const match = textBefore.match(/@([^@\n[\]]{2,})$/);
    if (match) {
      this.updateMentionDropdown(match[1]);
    } else {
      this.hideMentionDropdown();
    }
  }

  private updateMentionDropdown(query: string): void {
    const lower = query.toLowerCase();
    this.mentionMatches = this.app.vault
      .getMarkdownFiles()
      .map((f) => f.basename)
      .filter((name) => name.toLowerCase().includes(lower))
      .slice(0, 8);

    if (this.mentionMatches.length === 0) {
      this.hideMentionDropdown();
      return;
    }

    this.mentionSelectedIdx = 0;
    this.renderMentionDropdown();
    this.mentionDropdownEl.style.display = "block";
  }

  private renderMentionDropdown(): void {
    this.mentionDropdownEl.empty();
    this.mentionMatches.forEach((name, i) => {
      const item = this.mentionDropdownEl.createDiv(
        i === this.mentionSelectedIdx ? "vc-mention-item vc-mention-item--active" : "vc-mention-item"
      );
      item.setText(name);
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.insertMention(name);
      });
    });
  }

  private moveMentionSelection(dir: 1 | -1): void {
    this.mentionSelectedIdx =
      (this.mentionSelectedIdx + dir + this.mentionMatches.length) % this.mentionMatches.length;
    this.renderMentionDropdown();
  }

  private confirmMentionSelection(): void {
    const name = this.mentionMatches[this.mentionSelectedIdx];
    if (name) this.insertMention(name);
  }

  private insertMention(basename: string): void {
    const cursor = this.inputEl.selectionStart ?? 0;
    const text = this.inputEl.value;
    const textBefore = text.slice(0, cursor);
    const match = textBefore.match(/@([^@\n[\]]{2,})$/);
    if (!match) return;
    const start = cursor - match[0].length;
    const replacement = `[[${basename}]]`;
    this.inputEl.value = text.slice(0, start) + replacement + text.slice(cursor);
    const newCursor = start + replacement.length;
    this.inputEl.setSelectionRange(newCursor, newCursor);
    this.hideMentionDropdown();
  }

  private hideMentionDropdown(): void {
    this.mentionDropdownEl.style.display = "none";
    this.mentionDropdownEl.empty();
    this.mentionMatches = [];
    this.mentionSelectedIdx = 0;
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  private loadThreads(): void {
    this.threads = (this.plugin.data.threads ?? []) as Thread[];
  }

  saveThreads(): void {
    this.plugin.data.threads = this.threads;
    this.plugin.saveData(this.plugin.data);
  }

  private async saveThreadToVault(thread: Thread): Promise<void> {
    try {
      const folder = this.plugin.settings.threadsFolder;
      await this.app.vault.createFolder(folder).catch(() => {});

      const date = new Date(thread.created).toISOString().slice(0, 10);
      const safeName = thread.title.replace(/[\\/:*?"<>|]/g, " ").slice(0, 60);
      const fileName = `${folder}/${date} ${safeName}.md`;

      let content = `---\ncreated: ${date}\ntags: [chat]\n---\n\n# ${thread.title}\n\n`;
      for (const msg of thread.messages) {
        const role = msg.role === "user" ? "**Du**" : "**Claude**";
        content += `${role}: ${msg.content}\n\n`;
        if (msg.contextNotes && msg.contextNotes.length > 0) {
          const names = msg.contextNotes.map((p) => `[[${p.split("/").pop()?.replace(".md", "") ?? p}]]`);
          content += `> Kontext: ${names.join(", ")}\n\n`;
        }
      }

      const existing = this.app.vault.getAbstractFileByPath(fileName);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        await this.app.vault.create(fileName, content);
      }
    } catch {
      // silent fail
    }
  }
}
