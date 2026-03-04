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
  private modeHintEl!: HTMLElement;
  private sendBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private mentionDropdownEl!: HTMLElement;

  // Mention autocomplete state
  private mentionSelectedIdx = 0;
  private mentionMatches: string[] = [];

  // Active prompt extension buttons (file paths)
  private activeExtensions: Set<string> = new Set();

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

    // Prompt-extension mode buttons (centre)
    const modeBtns = header.createDiv("vc-header-modes");
    for (const pb of this.plugin.settings.promptButtons) {
      const modeBtn = modeBtns.createEl("button", { text: pb.label, cls: "vc-mode-btn" });
      modeBtn.onclick = () => {
        if (this.activeExtensions.has(pb.filePath)) {
          this.activeExtensions.delete(pb.filePath);
          modeBtn.removeClass("vc-mode-btn--active");
        } else {
          this.activeExtensions.add(pb.filePath);
          modeBtn.addClass("vc-mode-btn--active");
        }
        this.updateModeHint();
      };
    }

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

    // Mode hint panel (inside input area, above textarea)
    this.modeHintEl = inputArea.createDiv("vc-mode-hint");
    this.modeHintEl.style.display = "none";

    const inputWrapper = inputArea.createDiv("vc-input-wrapper");
    // Dropdown appended to root to escape overflow:hidden ancestors
    this.mentionDropdownEl = root.createDiv("vc-mention-dropdown");
    this.mentionDropdownEl.style.display = "none";
    this.inputEl = inputWrapper.createEl("textarea", {
      cls: "vc-input",
      attr: { placeholder: "Frage stellen… (@ für Notiz)" },
    });
    this.inputEl.rows = 3;

    const inputActions = inputArea.createDiv("vc-input-actions");

    const contextBtn = inputActions.createEl("button", { cls: "vc-ctx-btn", title: "Kontext manuell auswählen" });
    contextBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" stroke-width="2"/><path d="M14 2v6h6M8 13h8M8 17h5" stroke-width="2" stroke-linecap="round"/></svg> Kontext`;
    contextBtn.onclick = () => this.openContextPicker();

    this.sendBtn = inputActions.createEl("button", { cls: "vc-send-btn" });
    this.sendBtn.setText("Senden");
    this.sendBtn.onclick = () => this.handleSend();

    // Key bindings — use registerDomEvent for automatic cleanup on view close
    this.registerDomEvent(this.inputEl, "keydown", (e: KeyboardEvent) => {
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
      if (e.key === "Enter") {
        const isCmdEnter = e.metaKey || e.ctrlKey;
        const sendOnEnter = this.plugin.settings.sendOnEnter;
        if (isCmdEnter || (sendOnEnter && !e.shiftKey)) {
          e.preventDefault();
          e.stopPropagation();
          this.handleSend();
        }
      }
    });

    this.registerDomEvent(this.inputEl, "input", () => this.handleInputChange());

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

    // Parse @Notizname mentions from input
    const mentionPattern = /@([\w\däöüÄÖÜß][^@\n]{1,}?)(?=\s|$)/g;
    const mentions: TFile[] = [];
    let match;
    while ((match = mentionPattern.exec(query)) !== null) {
      const name = match[1].trim();
      const file = this.app.metadataCache.getFirstLinkpathDest(name, "");
      if (file) mentions.push(file);
    }

    // With active prompt extensions, skip auto-retrieve and clear any leftover context
    if (this.activeExtensions.size === 0) {
      if (this.plugin.settings.autoRetrieveContext && this.plugin.settings.showContextPreview) {
        if (this.pendingContext.length === 0 && this.explicitContext.length === 0) {
          await this.fetchAndShowContext(query, mentions);
          return; // wait for user to confirm/modify context
        }
      }
    } else {
      this.pendingContext = [];
      this.explicitContext = [];
    }

    // Date-based context for active date-search buttons
    const dateFiles: TFile[] = [];
    for (const pb of this.plugin.settings.promptButtons) {
      if (pb.searchMode === "date" && this.activeExtensions.has(pb.filePath)) {
        const { start, end, label } = this.parseDateRange(query);
        const found = this.findFilesByDate(start, end, pb.searchFolders ?? []);
        dateFiles.push(...found);
        this.setStatus(`${found.length} Texte aus ${label} gefunden`);
      }
    }

    await this.sendMessage(query, [...mentions, ...dateFiles]);
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

    // Build effective system prompt (base + any active extensions)
    let systemPrompt = this.plugin.settings.systemPrompt;
    for (const filePath of this.activeExtensions) {
      const file =
        this.app.metadataCache.getFirstLinkpathDest(filePath, "") ??
        (this.app.vault.getAbstractFileByPath(filePath + ".md") as TFile | null) ??
        (this.app.vault.getAbstractFileByPath(filePath) as TFile | null);
      if (file instanceof TFile) {
        const ext = await this.app.vault.cachedRead(file);
        systemPrompt += "\n\n---\n" + ext;
      }
    }

    try {
      const stream = this.plugin.claude.streamChat(claudeMessages, {
        apiKey: this.plugin.settings.apiKey,
        model: this.plugin.settings.model,
        systemPrompt,
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
      titleEl.onclick = () => this.app.workspace.openLinkText(result.file.path, "", "tab");

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

  private updateModeHint(): void {
    // Collect helpTexts from all active extensions that have one
    const hints: string[] = [];
    for (const pb of this.plugin.settings.promptButtons) {
      if (this.activeExtensions.has(pb.filePath) && pb.helpText) {
        hints.push(pb.helpText);
      }
    }
    if (hints.length > 0) {
      this.modeHintEl.empty();
      for (const hint of hints) {
        const div = this.modeHintEl.createDiv("vc-mode-hint-text");
        div.textContent = hint;
      }
      this.modeHintEl.style.display = "block";
      this.inputEl.placeholder = "";
    } else {
      this.modeHintEl.style.display = "none";
      this.inputEl.placeholder = "Frage stellen… (@ für Notiz)";
    }
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
      titleEl.ondblclick = (e) => {
        e.stopPropagation();
        this.startRenameThread(thread, titleEl);
      };

      const del = item.createEl("button", { cls: "vc-icon-btn vc-thread-del", title: "Löschen" });
      del.innerHTML = "✕";
      del.onclick = (e) => {
        e.stopPropagation();
        this.deleteThread(thread.id);
      };
    }
    this.renderHistorySection();
  }

  private startRenameThread(thread: Thread, titleEl: HTMLElement): void {
    const input = document.createElement("input");
    input.className = "vc-thread-rename";
    input.value = thread.title;
    titleEl.replaceWith(input);
    input.select();
    const finish = () => {
      const newTitle = input.value.trim() || thread.title;
      thread.title = newTitle;
      this.saveThreads();
      this.renderThreadList();
    };
    input.addEventListener("blur", finish);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { input.value = thread.title; input.blur(); }
    });
    input.focus();
  }

  private renderMessages(): void {
    this.messagesEl.empty();
    const thread = this.activeThread;
    if (!thread || thread.messages.length === 0) {
      const empty = this.messagesEl.createDiv("vc-empty");
      empty.createEl("div", { text: "💬", cls: "vc-empty-icon" });
      empty.createEl("div", { text: "Stell eine Frage — ich suche passende Notizen aus deinem Vault.", cls: "vc-empty-text" });
      empty.createEl("div", { text: "Tipp: Nutze @Notizname um eine Notiz direkt einzubinden.", cls: "vc-empty-hint" });
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
        // Wire up internal [[links]] to open / create notes
        mdEl.querySelectorAll("a.internal-link").forEach((a) => {
          const href = (a as HTMLAnchorElement).getAttribute("href") ?? a.textContent ?? "";
          const exists = !!this.app.metadataCache.getFirstLinkpathDest(href, "");
          if (!exists) {
            a.classList.add("is-unresolved");
            // Suggest similar existing notes
            const similar = this.plugin.search.findSimilarByName(href, 2, 0.45);
            if (similar.length > 0) {
              const hint = (a.parentElement as HTMLElement).createEl("span", { cls: "vc-link-hint" });
              hint.createEl("span", { text: " → Ähnliche Notiz: ", cls: "vc-link-hint-label" });
              similar.forEach((r, i) => {
                if (i > 0) hint.appendText(", ");
                const link = hint.createEl("a", { text: r.title, cls: "internal-link vc-link-hint-target" });
                link.addEventListener("click", (e) => {
                  e.preventDefault();
                  this.app.workspace.openLinkText(r.file.path, "", false);
                });
              });
              a.insertAdjacentElement("afterend", hint);
            }
          }
          a.addEventListener("click", (e) => {
            e.preventDefault();
            this.app.workspace.openLinkText(href, "", "tab");
          });
        });
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
        link.onclick = () => this.app.workspace.openLinkText(notePath, "", "tab");
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

  setStatus(text: string): void {
    this.statusEl.setText(text);
    this.statusEl.style.display = text ? "block" : "none";
  }

  /** Pre-fill the input textarea (used from plugin commands) */
  setInputValue(value: string): void {
    this.inputEl.value = value;
  }

  /** Add files as explicit context (used from plugin commands) */
  setExplicitContext(files: TFile[]): void {
    this.explicitContext = files;
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

    // Position using fixed coords to escape overflow:hidden ancestors
    const rect = this.inputEl.getBoundingClientRect();
    const el = this.mentionDropdownEl;
    el.style.position = "fixed";
    el.style.left = rect.left + "px";
    el.style.width = rect.width + "px";
    el.style.top = "auto";
    el.style.bottom = (window.innerHeight - rect.top + 4) + "px";
    el.style.display = "block";
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
    const match = textBefore.match(/@([^@\n]{2,})$/);
    if (!match) return;
    const start = cursor - match[0].length;
    const replacement = `@${basename}`;
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

  // ─── Date-based context search ────────────────────────────────────────────

  private parseDateRange(query: string): { start: Date; end: Date; label: string } {
    const now = new Date();
    const lower = query.toLowerCase();

    // Relative: letzter / voriger Monat
    if (/letzt[eaem]n?\s+monat|vorig[eaem]n?\s+monat/.test(lower)) {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
      return { start, end, label: start.toLocaleDateString("de-DE", { month: "long", year: "numeric" }) };
    }

    // German month names (+ optional year)
    const MONTHS: Record<string, number> = {
      januar: 0, februar: 1, "märz": 2, april: 3, mai: 4, juni: 5,
      juli: 6, august: 7, september: 8, oktober: 9, november: 10, dezember: 11,
    };
    for (const [name, idx] of Object.entries(MONTHS)) {
      if (lower.includes(name)) {
        const yearMatch = lower.match(/\b(20\d{2})\b/);
        const year = yearMatch ? parseInt(yearMatch[1]) : now.getFullYear();
        const start = new Date(year, idx, 1);
        const end = new Date(year, idx + 1, 0, 23, 59, 59);
        return { start, end, label: start.toLocaleDateString("de-DE", { month: "long", year: "numeric" }) };
      }
    }

    // Default: current month
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    return { start, end, label: start.toLocaleDateString("de-DE", { month: "long", year: "numeric" }) };
  }

  private getFileDate(file: TFile): Date {
    // 1. Filename starts with YYYY-MM-DD
    const m = file.basename.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    // 2. Frontmatter created / date / datum
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (fm) {
      const raw = fm["created"] ?? fm["date"] ?? fm["datum"];
      if (raw) { const d = new Date(raw); if (!isNaN(d.getTime())) return d; }
    }
    // 3. Filesystem ctime
    return new Date(file.stat.ctime);
  }

  private findFilesByDate(start: Date, end: Date, folders: string[]): TFile[] {
    const s = start.getTime();
    const e = end.getTime();
    return this.app.vault.getMarkdownFiles().filter((file) => {
      if (folders.length > 0 && !folders.some((f) => file.path.startsWith(f.endsWith("/") ? f : f + "/")))
        return false;
      const t = this.getFileDate(file).getTime();
      return t >= s && t <= e;
    });
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

      let content = `---\ncreated: ${date}\nid: ${thread.id}\ntags: [chat]\n---\n\n# ${thread.title}\n\n`;
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

  /** Parse a vault chat file back into a Thread object */
  private async parseThreadFromVault(file: TFile): Promise<Thread | null> {
    try {
      const raw = await this.app.vault.cachedRead(file);
      // Extract frontmatter id if present
      let id: string | undefined;
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const idMatch = fmMatch[1].match(/^id:\s*(.+)$/m);
        if (idMatch) id = idMatch[1].trim();
      }
      // Extract title from first h1
      const titleMatch = raw.match(/^# (.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : file.basename;
      // Extract messages
      const messages: ChatMessage[] = [];
      const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
      const lines = body.split("\n");
      let currentRole: "user" | "assistant" | null = null;
      let currentContent: string[] = [];
      const flush = () => {
        if (currentRole && currentContent.length > 0) {
          messages.push({
            role: currentRole,
            content: currentContent.join("\n").trim(),
            timestamp: file.stat.ctime,
          });
        }
        currentContent = [];
        currentRole = null;
      };
      for (const line of lines) {
        if (line.startsWith("**Du**: ")) {
          flush();
          currentRole = "user";
          currentContent.push(line.slice("**Du**: ".length));
        } else if (line.startsWith("**Claude**: ")) {
          flush();
          currentRole = "assistant";
          currentContent.push(line.slice("**Claude**: ".length));
        } else if (currentRole) {
          if (line.startsWith("> Kontext:")) continue; // skip context lines
          currentContent.push(line);
        }
      }
      flush();
      return {
        id: id ?? file.stat.ctime.toString(),
        title,
        messages,
        created: file.stat.ctime,
        updated: file.stat.mtime,
      };
    } catch {
      return null;
    }
  }

  /** Load saved vault files not already in this.threads */
  private async loadHistoryFromVault(): Promise<Thread[]> {
    const folder = this.plugin.settings.threadsFolder;
    const loadedIds = new Set(this.threads.map((t) => t.id));
    const results: Thread[] = [];
    const files = this.app.vault.getMarkdownFiles()
      .filter((f) => f.path.startsWith(folder + "/"))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
    for (const file of files) {
      const thread = await this.parseThreadFromVault(file);
      if (thread && !loadedIds.has(thread.id)) {
        results.push(thread);
        loadedIds.add(thread.id);
      }
    }
    return results;
  }

  // ─── Sidebar History ──────────────────────────────────────────────────────

  private historyExpanded = false;
  private historyThreads: Thread[] = [];

  async renderHistorySection(): Promise<void> {
    // Remove existing history section if any
    const existing = this.threadListEl.parentElement?.querySelector(".vc-history-section");
    if (existing) existing.remove();

    if (!this.plugin.settings.saveThreadsToVault) return;

    const sidebar = this.threadListEl.parentElement as HTMLElement;
    const section = sidebar.createDiv("vc-history-section");

    const toggle = section.createDiv("vc-history-toggle");
    toggle.createEl("span", { text: this.historyExpanded ? "▾" : "▸", cls: "vc-history-arrow" });
    toggle.createEl("span", { text: "Verlauf", cls: "vc-history-label" });

    const listEl = section.createDiv("vc-history-list");
    listEl.style.display = this.historyExpanded ? "block" : "none";

    toggle.onclick = async () => {
      this.historyExpanded = !this.historyExpanded;
      toggle.empty();
      toggle.createEl("span", { text: this.historyExpanded ? "▾" : "▸", cls: "vc-history-arrow" });
      toggle.createEl("span", { text: "Verlauf", cls: "vc-history-label" });
      listEl.style.display = this.historyExpanded ? "block" : "none";
      if (this.historyExpanded && this.historyThreads.length === 0) {
        listEl.setText("Lade…");
        this.historyThreads = await this.loadHistoryFromVault();
        this.renderHistoryList(listEl);
      }
    };

    if (this.historyExpanded) {
      if (this.historyThreads.length === 0) {
        this.historyThreads = await this.loadHistoryFromVault();
      }
      this.renderHistoryList(listEl);
    }
  }

  private renderHistoryList(listEl: HTMLElement): void {
    listEl.empty();
    if (this.historyThreads.length === 0) {
      listEl.createEl("div", { text: "Keine gespeicherten Chats", cls: "vc-history-empty" });
      return;
    }
    for (const thread of this.historyThreads) {
      const item = listEl.createDiv("vc-history-item");
      item.createEl("span", { text: thread.title, cls: "vc-thread-title" });
      item.onclick = () => {
        // Import into active threads and switch
        this.threads.unshift(thread);
        this.historyThreads = this.historyThreads.filter((t) => t.id !== thread.id);
        this.switchThread(thread.id);
        this.renderHistoryList(listEl);
      };
    }
  }
}
