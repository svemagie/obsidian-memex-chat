var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => MemexChatPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian4 = require("obsidian");

// src/ChatView.ts
var import_obsidian = require("obsidian");
var VIEW_TYPE_MEMEX_CHAT = "memex-chat-view";
var ChatView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.threads = [];
    this.activeThreadId = null;
    this.pendingContext = [];
    this.explicitContext = [];
    this.isLoading = false;
    this.plugin = plugin;
    this.renderComponent = new import_obsidian.Component();
  }
  getViewType() {
    return VIEW_TYPE_MEMEX_CHAT;
  }
  getDisplayText() {
    return "Memex Chat";
  }
  getIcon() {
    return "message-circle";
  }
  async onOpen() {
    this.renderComponent.load();
    this.loadThreads();
    this.buildUI();
    if (!this.activeThreadId && this.threads.length === 0) {
      this.newThread();
    } else if (!this.activeThreadId && this.threads.length > 0) {
      this.switchThread(this.threads[0].id);
    }
  }
  async onClose() {
    this.renderComponent.unload();
    this.saveThreads();
  }
  // ─── UI Construction ─────────────────────────────────────────────────────
  buildUI() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("vc-root");
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
      this.setStatus("Indiziere Vault\u2026");
      await this.plugin.rebuildIndex();
      this.setStatus(`\u2713 ${this.plugin.search.isIndexed() ? "Index bereit" : ""}`);
      setTimeout(() => this.setStatus(""), 2e3);
      rebuildBtn.disabled = false;
    };
    const main = root.createDiv("vc-main");
    const sidebar = main.createDiv("vc-sidebar");
    sidebar.createEl("div", { text: "Threads", cls: "vc-sidebar-title" });
    this.threadListEl = sidebar.createDiv("vc-thread-list");
    const chatArea = main.createDiv("vc-chat-area");
    this.statusEl = chatArea.createDiv("vc-status");
    this.messagesEl = chatArea.createDiv("vc-messages");
    this.contextPreviewEl = chatArea.createDiv("vc-context-preview");
    this.contextPreviewEl.style.display = "none";
    const inputArea = chatArea.createDiv("vc-input-area");
    const inputWrapper = inputArea.createDiv("vc-input-wrapper");
    this.inputEl = inputWrapper.createEl("textarea", {
      cls: "vc-input",
      attr: { placeholder: "Frage stellen\u2026 (@ f\xFCr Notiz einf\xFCgen)" }
    });
    this.inputEl.rows = 3;
    const inputActions = inputArea.createDiv("vc-input-actions");
    const contextBtn = inputActions.createEl("button", { cls: "vc-ctx-btn", title: "Kontext manuell ausw\xE4hlen" });
    contextBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" stroke-width="2"/><path d="M14 2v6h6M8 13h8M8 17h5" stroke-width="2" stroke-linecap="round"/></svg> Kontext`;
    contextBtn.onclick = () => this.openContextPicker();
    this.sendBtn = inputActions.createEl("button", { cls: "vc-send-btn" });
    this.sendBtn.setText("Senden");
    this.sendBtn.onclick = () => this.handleSend();
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.handleSend();
      }
    });
    this.inputEl.addEventListener("input", () => this.handleInputChange());
    this.renderThreadList();
  }
  // ─── Thread Management ────────────────────────────────────────────────────
  newThread() {
    const thread = {
      id: Date.now().toString(),
      title: "Neuer Chat",
      messages: [],
      created: Date.now(),
      updated: Date.now()
    };
    this.threads.unshift(thread);
    this.switchThread(thread.id);
    this.saveThreads();
  }
  switchThread(id) {
    this.saveThreads();
    this.activeThreadId = id;
    this.renderThreadList();
    this.renderMessages();
    this.clearContextPreview();
  }
  get activeThread() {
    return this.threads.find((t) => t.id === this.activeThreadId);
  }
  deleteThread(id) {
    this.threads = this.threads.filter((t) => t.id !== id);
    if (this.activeThreadId === id) {
      if (this.threads.length > 0)
        this.switchThread(this.threads[0].id);
      else
        this.newThread();
    }
    this.saveThreads();
    this.renderThreadList();
  }
  // ─── Send & Context ──────────────────────────────────────────────────────
  async handleSend() {
    const query = this.inputEl.value.trim();
    if (!query || this.isLoading)
      return;
    if (!this.plugin.settings.apiKey) {
      this.setStatus("\u26A0 Bitte API Key in den Einstellungen eingeben");
      return;
    }
    const mentionPattern = /\[\[([^\]]+)\]\]/g;
    const mentions = [];
    let match;
    while ((match = mentionPattern.exec(query)) !== null) {
      const name = match[1];
      const file = this.app.metadataCache.getFirstLinkpathDest(name, "");
      if (file)
        mentions.push(file);
    }
    if (this.plugin.settings.autoRetrieveContext && this.plugin.settings.showContextPreview) {
      if (this.pendingContext.length === 0 && this.explicitContext.length === 0) {
        await this.fetchAndShowContext(query, mentions);
        return;
      }
    }
    await this.sendMessage(query, mentions);
  }
  async fetchAndShowContext(query, mentions) {
    this.setStatus("Suche relevante Notizen\u2026");
    this.isLoading = true;
    try {
      if (!this.plugin.search.isIndexed()) {
        this.setStatus("Indiziere Vault\u2026");
        await this.plugin.search.buildIndex();
      }
      this.pendingContext = await this.plugin.search.search(query, this.plugin.settings.maxContextNotes);
      this.explicitContext = mentions;
      this.renderContextPreview();
      this.setStatus("Kontext bereit \u2014 Senden best\xE4tigen oder anpassen");
    } catch (e) {
      this.setStatus("Fehler bei Kontextsuche: " + e.message);
    }
    this.isLoading = false;
  }
  async sendMessage(query, additionalFiles = []) {
    this.isLoading = true;
    this.sendBtn.disabled = true;
    const thread = this.activeThread;
    if (!thread)
      return;
    const contextFiles = [
      ...this.explicitContext,
      ...this.pendingContext.map((r) => r.file),
      ...additionalFiles
    ].filter((f, i, arr) => arr.findIndex((x) => x.path === f.path) === i);
    const contextNotes = contextFiles.map((f) => f.path);
    let contextText = "";
    if (contextFiles.length > 0) {
      this.setStatus(`Lade ${contextFiles.length} Notizen\u2026`);
      const contents = await Promise.all(
        contextFiles.map(async (f) => {
          const content = await this.plugin.search.getContent(f, this.plugin.settings.maxCharsPerNote);
          return `=== [[${f.basename}]] ===
${content}`;
        })
      );
      contextText = "\n\n---\nKontext aus dem Vault:\n\n" + contents.join("\n\n");
    }
    const userMsg = {
      role: "user",
      content: query,
      timestamp: Date.now(),
      contextNotes
    };
    thread.messages.push(userMsg);
    thread.updated = Date.now();
    if (thread.messages.length === 1) {
      thread.title = query.slice(0, 50) + (query.length > 50 ? "\u2026" : "");
    }
    this.inputEl.value = "";
    this.pendingContext = [];
    this.explicitContext = [];
    this.clearContextPreview();
    this.renderMessages();
    this.renderThreadList();
    const assistantMsg = {
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true
    };
    thread.messages.push(assistantMsg);
    this.renderMessages();
    const claudeMessages = thread.messages.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content
    }));
    claudeMessages.push({
      role: "user",
      content: query + contextText
    });
    this.setStatus("Claude denkt\u2026");
    try {
      const stream = this.plugin.claude.streamChat(claudeMessages, {
        apiKey: this.plugin.settings.apiKey,
        model: this.plugin.settings.model,
        systemPrompt: this.plugin.settings.systemPrompt
      });
      for await (const chunk of stream) {
        if (chunk.type === "text" && chunk.text) {
          assistantMsg.content += chunk.text;
          this.updateLastMessage(assistantMsg.content);
        } else if (chunk.type === "error") {
          assistantMsg.content = `\u274C Fehler: ${chunk.error}`;
          this.updateLastMessage(assistantMsg.content);
          break;
        }
      }
      assistantMsg.isStreaming = false;
      assistantMsg.contextNotes = contextNotes;
      this.setStatus("");
      this.renderMessages();
      this.saveThreads();
      if (this.plugin.settings.saveThreadsToVault) {
        await this.saveThreadToVault(thread);
      }
    } catch (e) {
      assistantMsg.content = `\u274C Fehler: ${e.message}`;
      assistantMsg.isStreaming = false;
      this.renderMessages();
      this.setStatus("");
    }
    this.isLoading = false;
    this.sendBtn.disabled = false;
    this.scrollToBottom();
  }
  // ─── Context Preview ──────────────────────────────────────────────────────
  renderContextPreview() {
    this.contextPreviewEl.empty();
    this.contextPreviewEl.style.display = "block";
    const header = this.contextPreviewEl.createDiv("vc-ctx-header");
    header.createEl("span", { text: `\u{1F4CE} Kontext (${this.pendingContext.length} Notizen)`, cls: "vc-ctx-title" });
    const actions = header.createDiv("vc-ctx-actions");
    const confirmBtn = actions.createEl("button", { cls: "vc-send-btn vc-send-btn--sm", text: "\u2713 Senden" });
    confirmBtn.onclick = () => this.sendMessage(this.inputEl.value.trim());
    const clearBtn = actions.createEl("button", { cls: "vc-ctx-btn", text: "\u2717 Ohne Kontext" });
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
      removeBtn.innerHTML = `\u2715`;
      removeBtn.onclick = () => {
        this.pendingContext = this.pendingContext.filter((r) => r.file.path !== result.file.path);
        this.renderContextPreview();
      };
      const excerpt = item.createDiv("vc-ctx-excerpt");
      excerpt.setText(result.excerpt.slice(0, 120) + "\u2026");
    }
  }
  clearContextPreview() {
    this.contextPreviewEl.style.display = "none";
    this.contextPreviewEl.empty();
    this.pendingContext = [];
    this.explicitContext = [];
    this.setStatus("");
  }
  async openContextPicker() {
    const query = this.inputEl.value.trim() || "Notiz";
    this.setStatus("Suche Notizen\u2026");
    try {
      if (!this.plugin.search.isIndexed())
        await this.plugin.search.buildIndex();
      const results = await this.plugin.search.search(query, this.plugin.settings.maxContextNotes);
      this.pendingContext = results;
      this.renderContextPreview();
      this.setStatus("");
    } catch (e) {
      this.setStatus("Fehler: " + e.message);
    }
  }
  // ─── Rendering ────────────────────────────────────────────────────────────
  renderThreadList() {
    this.threadListEl.empty();
    for (const thread of this.threads) {
      const item = this.threadListEl.createDiv("vc-thread-item" + (thread.id === this.activeThreadId ? " vc-thread-item--active" : ""));
      const titleEl = item.createEl("span", { text: thread.title, cls: "vc-thread-title" });
      titleEl.onclick = () => this.switchThread(thread.id);
      const del = item.createEl("button", { cls: "vc-icon-btn vc-thread-del", title: "L\xF6schen" });
      del.innerHTML = "\u2715";
      del.onclick = (e) => {
        e.stopPropagation();
        this.deleteThread(thread.id);
      };
    }
  }
  renderMessages() {
    this.messagesEl.empty();
    const thread = this.activeThread;
    if (!thread || thread.messages.length === 0) {
      const empty = this.messagesEl.createDiv("vc-empty");
      empty.createEl("div", { text: "\u{1F4AC}", cls: "vc-empty-icon" });
      empty.createEl("div", { text: "Stell eine Frage \u2014 ich suche passende Notizen aus deinem Vault.", cls: "vc-empty-text" });
      empty.createEl("div", { text: "Tipp: Nutze @[[Notizname]] um eine Notiz direkt einzubinden.", cls: "vc-empty-hint" });
      return;
    }
    for (const msg of thread.messages) {
      this.renderMessage(msg);
    }
    this.scrollToBottom();
  }
  renderMessage(msg) {
    var _a;
    const msgEl = this.messagesEl.createDiv(`vc-msg vc-msg--${msg.role}`);
    const bubble = msgEl.createDiv("vc-bubble");
    if (msg.role === "user") {
      bubble.setText(msg.content);
    } else {
      const mdEl = bubble.createDiv("vc-md");
      if (msg.isStreaming) {
        mdEl.setText(msg.content);
        mdEl.createEl("span", { cls: "vc-cursor", text: "\u2588" });
      } else {
        import_obsidian.MarkdownRenderer.render(this.app, msg.content, mdEl, "", this.renderComponent);
      }
    }
    if (!msg.isStreaming && msg.contextNotes && msg.contextNotes.length > 0) {
      const sources = msgEl.createDiv("vc-sources");
      sources.createEl("span", { text: "Quellen: ", cls: "vc-sources-label" });
      for (const notePath of msg.contextNotes) {
        const file = this.app.vault.getAbstractFileByPath(notePath);
        const name = file instanceof import_obsidian.TFile ? file.basename : (_a = notePath.split("/").pop()) != null ? _a : notePath;
        const link = sources.createEl("span", { text: `[[${name}]]`, cls: "vc-source-link" });
        link.onclick = () => this.app.workspace.openLinkText(notePath, "", false);
      }
    }
  }
  updateLastMessage(content) {
    const messages = this.messagesEl.querySelectorAll(".vc-msg--assistant");
    const last = messages[messages.length - 1];
    if (!last)
      return;
    const mdEl = last.querySelector(".vc-md");
    if (mdEl) {
      mdEl.textContent = content;
      const cursor = mdEl.querySelector(".vc-cursor");
      if (!cursor)
        mdEl.createEl("span", { cls: "vc-cursor", text: "\u2588" });
    }
    this.scrollToBottom();
  }
  scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
  setStatus(text) {
    this.statusEl.setText(text);
    this.statusEl.style.display = text ? "block" : "none";
  }
  handleInputChange() {
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 200) + "px";
  }
  // ─── Persistence ─────────────────────────────────────────────────────────
  loadThreads() {
    var _a;
    this.threads = (_a = this.plugin.data.threads) != null ? _a : [];
  }
  saveThreads() {
    this.plugin.data.threads = this.threads;
    this.plugin.saveData(this.plugin.data);
  }
  async saveThreadToVault(thread) {
    try {
      const folder = this.plugin.settings.threadsFolder;
      await this.app.vault.createFolder(folder).catch(() => {
      });
      const date = new Date(thread.created).toISOString().slice(0, 10);
      const safeName = thread.title.replace(/[\\/:*?"<>|]/g, " ").slice(0, 60);
      const fileName = `${folder}/${date} ${safeName}.md`;
      let content = `---
created: ${date}
tags: [chat]
---

# ${thread.title}

`;
      for (const msg of thread.messages) {
        const role = msg.role === "user" ? "**Du**" : "**Claude**";
        content += `${role}: ${msg.content}

`;
        if (msg.contextNotes && msg.contextNotes.length > 0) {
          const names = msg.contextNotes.map((p) => {
            var _a, _b;
            return `[[${(_b = (_a = p.split("/").pop()) == null ? void 0 : _a.replace(".md", "")) != null ? _b : p}]]`;
          });
          content += `> Kontext: ${names.join(", ")}

`;
        }
      }
      const existing = this.app.vault.getAbstractFileByPath(fileName);
      if (existing instanceof import_obsidian.TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        await this.app.vault.create(fileName, content);
      }
    } catch (e) {
    }
  }
};

// src/VaultSearch.ts
var VaultSearch = class {
  constructor(app) {
    this.docVectors = /* @__PURE__ */ new Map();
    // path -> term -> tfidf
    this.idf = /* @__PURE__ */ new Map();
    this.docContents = /* @__PURE__ */ new Map();
    this.indexed = false;
    this.indexing = false;
    this.app = app;
  }
  /** Tokenize text: lowercase, split on non-word chars, keep umlauts */
  tokenize(text) {
    return text.toLowerCase().replace(/[^\wäöüßÄÖÜ\s]/g, " ").split(/\s+/).filter((t) => t.length > 2);
  }
  /** Strip YAML frontmatter and Obsidian-specific markup */
  cleanContent(raw) {
    let content = raw;
    if (content.startsWith("---")) {
      const end = content.indexOf("\n---", 3);
      if (end > 0)
        content = content.slice(end + 4);
    }
    content = content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => alias || target);
    content = content.replace(/!\[.*?\]\(.*?\)/g, "");
    content = content.replace(/\[([^\]]+)\]\(.*?\)/g, "$1");
    content = content.replace(/>\s*\[!\w+\][+-]?\s*/g, "");
    content = content.replace(/^#{1,6}\s+/gm, "");
    return content;
  }
  /** Build or rebuild the TF-IDF index */
  async buildIndex() {
    var _a, _b, _c;
    if (this.indexing)
      return;
    this.indexing = true;
    this.indexed = false;
    this.docVectors.clear();
    this.idf.clear();
    this.docContents.clear();
    const files = this.app.vault.getMarkdownFiles();
    const total = files.length;
    const df = /* @__PURE__ */ new Map();
    const tfs = /* @__PURE__ */ new Map();
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (this.onProgress && i % 100 === 0)
        this.onProgress(i, total);
      try {
        const raw = await this.app.vault.cachedRead(file);
        const clean = this.cleanContent(raw);
        this.docContents.set(file.path, clean);
        const tokens = this.tokenize(clean + " " + file.basename);
        const tf = /* @__PURE__ */ new Map();
        for (const t of tokens) {
          tf.set(t, ((_a = tf.get(t)) != null ? _a : 0) + 1);
        }
        const maxTf = Math.max(...tf.values(), 1);
        const normalizedTf = /* @__PURE__ */ new Map();
        for (const [t, count] of tf) {
          normalizedTf.set(t, count / maxTf);
        }
        tfs.set(file.path, normalizedTf);
        for (const t of tf.keys()) {
          df.set(t, ((_b = df.get(t)) != null ? _b : 0) + 1);
        }
      } catch (e) {
      }
    }
    const N = files.length;
    for (const [term, docCount] of df) {
      this.idf.set(term, Math.log(N / docCount + 1));
    }
    for (const [path, tf] of tfs) {
      const vec = /* @__PURE__ */ new Map();
      let norm = 0;
      for (const [term, tfVal] of tf) {
        const idfVal = (_c = this.idf.get(term)) != null ? _c : 0;
        const tfidf = tfVal * idfVal;
        vec.set(term, tfidf);
        norm += tfidf * tfidf;
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (const [term, val] of vec) {
          vec.set(term, val / norm);
        }
      }
      this.docVectors.set(path, vec);
    }
    this.indexed = true;
    this.indexing = false;
    if (this.onProgress)
      this.onProgress(total, total);
  }
  isIndexed() {
    return this.indexed;
  }
  /** Search for the top-K most similar notes to the query */
  async search(query, topK = 8) {
    var _a, _b, _c;
    if (!this.indexed)
      await this.buildIndex();
    const tokens = this.tokenize(query);
    const qtf = /* @__PURE__ */ new Map();
    for (const t of tokens)
      qtf.set(t, ((_a = qtf.get(t)) != null ? _a : 0) + 1);
    const qMax = Math.max(...qtf.values(), 1);
    const qvec = /* @__PURE__ */ new Map();
    let qnorm = 0;
    for (const [t, count] of qtf) {
      const tfidf = count / qMax * ((_b = this.idf.get(t)) != null ? _b : 0);
      qvec.set(t, tfidf);
      qnorm += tfidf * tfidf;
    }
    qnorm = Math.sqrt(qnorm);
    if (qnorm > 0)
      for (const [t, v] of qvec)
        qvec.set(t, v / qnorm);
    const scores = [];
    for (const [path, vec] of this.docVectors) {
      let score = 0;
      for (const [t, qv] of qvec) {
        const dv = (_c = vec.get(t)) != null ? _c : 0;
        score += qv * dv;
      }
      if (score > 0.01)
        scores.push([path, score]);
    }
    scores.sort((a, b) => b[1] - a[1]);
    const top = scores.slice(0, topK);
    const files = this.app.vault.getMarkdownFiles();
    const fileMap = new Map(files.map((f) => [f.path, f]));
    return top.map(([path, score]) => {
      var _a2;
      const file = fileMap.get(path);
      if (!file)
        return null;
      const content = (_a2 = this.docContents.get(path)) != null ? _a2 : "";
      const excerpt = this.buildExcerpt(content, query, 300);
      return { file, score, excerpt, title: file.basename };
    }).filter(Boolean);
  }
  /** Get note content for context injection */
  async getContent(file, maxChars = 3e3) {
    try {
      const raw = await this.app.vault.cachedRead(file);
      return this.cleanContent(raw).slice(0, maxChars);
    } catch (e) {
      return "";
    }
  }
  buildExcerpt(content, query, maxLen) {
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
    if (bestPos > 0)
      excerpt = "\u2026" + excerpt;
    if (bestPos + maxLen < content.length)
      excerpt += "\u2026";
    return excerpt;
  }
};

// src/ClaudeClient.ts
var import_obsidian2 = require("obsidian");
var ClaudeClient = class {
  constructor() {
    this.baseUrl = "https://api.anthropic.com/v1/messages";
  }
  headers(apiKey) {
    return {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    };
  }
  /**
   * "Stream" a chat completion via requestUrl (no real streaming — CORS blocks
   * native fetch from app://obsidian.md). Yields the full response as a single
   * text chunk so ChatView's streaming loop keeps working unchanged.
   */
  async *streamChat(messages, options) {
    var _a, _b, _c, _d;
    const response = await (0, import_obsidian2.requestUrl)({
      url: this.baseUrl,
      method: "POST",
      headers: this.headers(options.apiKey),
      body: JSON.stringify({
        model: options.model,
        max_tokens: (_a = options.maxTokens) != null ? _a : 2048,
        system: options.systemPrompt,
        messages
      }),
      throw: false
    });
    if (response.status >= 400) {
      yield { type: "error", error: `API Error ${response.status}: ${response.text}` };
      return;
    }
    const text = (_d = (_c = (_b = response.json.content) == null ? void 0 : _b[0]) == null ? void 0 : _c.text) != null ? _d : "";
    yield { type: "text", text };
    yield { type: "done" };
  }
  /** Non-streaming convenience wrapper */
  async chat(messages, options) {
    var _a, _b, _c, _d;
    const response = await (0, import_obsidian2.requestUrl)({
      url: this.baseUrl,
      method: "POST",
      headers: this.headers(options.apiKey),
      body: JSON.stringify({
        model: options.model,
        max_tokens: (_a = options.maxTokens) != null ? _a : 2048,
        system: options.systemPrompt,
        messages
      }),
      throw: false
    });
    if (response.status >= 400) {
      throw new Error(`API Error ${response.status}: ${response.text}`);
    }
    return (_d = (_c = (_b = response.json.content) == null ? void 0 : _b[0]) == null ? void 0 : _c.text) != null ? _d : "";
  }
};

// src/SettingsTab.ts
var import_obsidian3 = require("obsidian");
var DEFAULT_SETTINGS = {
  apiKey: "",
  model: "claude-opus-4-5-20251101",
  maxContextNotes: 6,
  maxCharsPerNote: 2500,
  systemPrompt: `Du bist ein hilfreicher Assistent mit Zugriff auf die pers\xF6nliche Wissensdatenbank des Nutzers (Obsidian Vault).

Wenn du Fragen beantwortest:
- Nutze die bereitgestellten Notizen als prim\xE4re Wissensquelle
- Verweise auf relevante Notizen mit [[doppelten eckigen Klammern]]
- Antworte auf Deutsch, wenn die Frage auf Deutsch gestellt wird
- Wenn der Kontext unzureichend ist, sage das ehrlich und gib an, was noch fehlen k\xF6nnte
- Verkn\xFCpfe Konzepte aus verschiedenen Notizen kreativ miteinander`,
  autoRetrieveContext: true,
  showContextPreview: true,
  saveThreadsToVault: true,
  threadsFolder: "Calendar/Chat"
};
var MODELS = [
  { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5 (St\xE4rkst)" },
  { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5 (Empfohlen)" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (Schnell)" },
  { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5" }
];
var MemexChatSettingsTab = class extends import_obsidian3.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Memex Chat Einstellungen" });
    containerEl.createEl("h3", { text: "Claude API" });
    new import_obsidian3.Setting(containerEl).setName("API Key").setDesc("Dein Anthropic API Key (sk-ant-...)").addText(
      (text) => text.setPlaceholder("sk-ant-api03-...").setValue(this.plugin.settings.apiKey).onChange(async (value) => {
        this.plugin.settings.apiKey = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Modell").setDesc("Welches Claude-Modell verwenden?").addDropdown((drop) => {
      for (const m of MODELS)
        drop.addOption(m.id, m.name);
      drop.setValue(this.plugin.settings.model).onChange(async (value) => {
        this.plugin.settings.model = value;
        await this.plugin.saveSettings();
      });
    });
    containerEl.createEl("h3", { text: "Kontext-Einstellungen" });
    new import_obsidian3.Setting(containerEl).setName("Max. Kontext-Notizen").setDesc("Wie viele Notizen werden automatisch als Kontext hinzugef\xFCgt? (1\u201315)").addSlider(
      (slider) => slider.setLimits(1, 15, 1).setValue(this.plugin.settings.maxContextNotes).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.maxContextNotes = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Max. Zeichen pro Notiz").setDesc("Wie viele Zeichen einer Notiz in den Kontext einbezogen werden (1000\u20138000)").addSlider(
      (slider) => slider.setLimits(1e3, 8e3, 500).setValue(this.plugin.settings.maxCharsPerNote).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.maxCharsPerNote = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Automatischer Kontext-Abruf").setDesc("Beim Senden automatisch relevante Notizen suchen und einbinden").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.autoRetrieveContext).onChange(async (value) => {
        this.plugin.settings.autoRetrieveContext = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Kontext-Vorschau anzeigen").setDesc("Vor dem Senden zeigen, welche Notizen als Kontext verwendet werden").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.showContextPreview).onChange(async (value) => {
        this.plugin.settings.showContextPreview = value;
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "Thread-History" });
    new import_obsidian3.Setting(containerEl).setName("Threads im Vault speichern").setDesc("Chat-Threads als Markdown-Notizen im Vault ablegen").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.saveThreadsToVault).onChange(async (value) => {
        this.plugin.settings.saveThreadsToVault = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Threads-Ordner").setDesc("Pfad im Vault, wo Chat-Threads gespeichert werden").addText(
      (text) => text.setPlaceholder("Calendar/Chat").setValue(this.plugin.settings.threadsFolder).onChange(async (value) => {
        this.plugin.settings.threadsFolder = value;
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "System Prompt" });
    new import_obsidian3.Setting(containerEl).setName("System Prompt").setDesc("Instruktionen f\xFCr Claude (wie soll er sich verhalten?)").addTextArea((textarea) => {
      textarea.setValue(this.plugin.settings.systemPrompt).onChange(async (value) => {
        this.plugin.settings.systemPrompt = value;
        await this.plugin.saveSettings();
      });
      textarea.inputEl.rows = 8;
      textarea.inputEl.style.width = "100%";
      textarea.inputEl.style.fontFamily = "monospace";
      textarea.inputEl.style.fontSize = "12px";
    });
    containerEl.createEl("h3", { text: "Aktionen" });
    new import_obsidian3.Setting(containerEl).setName("Index neu aufbauen").setDesc("Vault-Index f\xFCr die Suche neu aufbauen (dauert je nach Vault-Gr\xF6\xDFe einige Sekunden)").addButton(
      (btn) => btn.setButtonText("Index neu aufbauen").setCta().onClick(async () => {
        btn.setButtonText("Indiziere\u2026");
        btn.setDisabled(true);
        await this.plugin.rebuildIndex();
        btn.setButtonText("\u2713 Fertig!");
        setTimeout(() => {
          btn.setButtonText("Index neu aufbauen");
          btn.setDisabled(false);
        }, 2e3);
      })
    );
  }
};

// src/main.ts
var MemexChatPlugin = class extends import_obsidian4.Plugin {
  async onload() {
    var _a, _b;
    const loaded = await this.loadData();
    this.data = {
      settings: { ...DEFAULT_SETTINGS, ...(_a = loaded == null ? void 0 : loaded.settings) != null ? _a : {} },
      threads: (_b = loaded == null ? void 0 : loaded.threads) != null ? _b : []
    };
    this.settings = this.data.settings;
    this.search = new VaultSearch(this.app);
    this.claude = new ClaudeClient();
    this.registerView(VIEW_TYPE_MEMEX_CHAT, (leaf) => new ChatView(leaf, this));
    this.addRibbonIcon("message-circle", "Memex Chat \xF6ffnen", () => {
      this.activateView();
    });
    this.addCommand({
      id: "open-memex-chat",
      name: "Memex Chat \xF6ffnen",
      callback: () => this.activateView()
    });
    this.addCommand({
      id: "memex-chat-rebuild-index",
      name: "Memex Chat: Index neu aufbauen",
      callback: () => this.rebuildIndex()
    });
    this.addCommand({
      id: "memex-chat-active-note",
      name: "Memex Chat: Aktive Notiz als Kontext",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file) {
          this.activateView().then(() => {
            const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_MEMEX_CHAT)[0];
            if (leaf) {
              const view = leaf.view;
              view.inputEl.value = `Erkl\xE4re und verkn\xFCpfe [[${file.basename}]] mit anderen Konzepten im Vault.`;
              view.explicitContext = [file];
            }
          });
        }
      }
    });
    this.addSettingTab(new MemexChatSettingsTab(this.app, this));
    setTimeout(() => {
      if (!this.search.isIndexed()) {
        this.search.buildIndex().catch(console.error);
      }
    }, 3e3);
    console.log("[Memex Chat] Plugin geladen");
  }
  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_MEMEX_CHAT);
  }
  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_MEMEX_CHAT);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf)
      return;
    await leaf.setViewState({ type: VIEW_TYPE_MEMEX_CHAT, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
  async rebuildIndex() {
    var _a;
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MEMEX_CHAT);
    const view = (_a = leaves[0]) == null ? void 0 : _a.view;
    this.search.onProgress = (done, total) => {
      if (view && done % 200 === 0) {
        view.setStatus(`Indiziere\u2026 ${done}/${total}`);
      }
    };
    await this.search.buildIndex();
    this.search.onProgress = void 0;
    if (view) {
      view.setStatus(`\u2713 ${this.app.vault.getMarkdownFiles().length} Notizen indiziert`);
      setTimeout(() => {
        view.setStatus("");
      }, 3e3);
    }
  }
  async saveSettings() {
    this.data.settings = this.settings;
    await this.saveData(this.data);
  }
};
