import { App, ButtonComponent, DropdownComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import type MemexChatPlugin from "./main";
import { EMBEDDING_MODELS } from "./EmbedSearch";

export interface PromptButton {
  label: string;
  filePath: string;         // vault-relative path to the system-prompt note (without .md)
  searchMode?: "date";      // if set: load notes by date range instead of TF-IDF
  searchFolders?: string[]; // folders to restrict date search (empty = all vault)
  helpText?: string;        // shown as info panel + changes placeholder when button is active
}

export interface MemexChatSettings {
  apiKey: string;
  model: string;
  maxTokens: number;
  maxContextNotes: number;
  maxCharsPerNote: number;
  systemPrompt: string;
  autoRetrieveContext: boolean;
  showContextPreview: boolean;
  saveThreadsToVault: boolean;
  threadsFolder: string;
  sendOnEnter: boolean;
  contextProperties: string[];
  promptButtons: PromptButton[];
  systemContextFile: string; // optional vault path for extended system context
  useEmbeddings: boolean;         // use local embedding model instead of TF-IDF
  embeddingModel: string;         // HuggingFace model ID
  embedExcludeFolders: string[];  // vault folders to skip during embedding
}

export const DEFAULT_SETTINGS: MemexChatSettings = {
  apiKey: "",
  model: "claude-opus-4-6",
  maxTokens: 8192,
  maxContextNotes: 6,
  maxCharsPerNote: 2500,
  systemPrompt: `Du bist ein hilfreicher Assistent mit Zugriff auf die persönliche Wissensdatenbank des Nutzers (Obsidian Vault).

Wenn du Fragen beantwortest:
- Nutze die bereitgestellten Notizen als primäre Wissensquelle
- Verweise auf relevante Notizen mit [[doppelten eckigen Klammern]]
- Antworte auf Deutsch, wenn die Frage auf Deutsch gestellt wird
- Wenn der Kontext unzureichend ist, sage das ehrlich und gib an, was noch fehlen könnte
- Verknüpfe Konzepte aus verschiedenen Notizen kreativ miteinander`,
  autoRetrieveContext: true,
  showContextPreview: true,
  saveThreadsToVault: true,
  threadsFolder: "Calendar/Chat",
  sendOnEnter: false,
  contextProperties: ["collection", "related", "up", "tags"],
  systemContextFile: "",
  useEmbeddings: false,
  embeddingModel: "TaylorAI/bge-micro-v2",
  embedExcludeFolders: [],
  promptButtons: [
    {
      label: "Draft Check",
      filePath: "Schreibdenken/ferals/Code/Prompts/COHERENCE CHECK",
      helpText: "📝 DRAFT — Frühphase: Kernbotschaft, Kohärenz, grobe Struktur\n✂️ PRE-PUBLISH — Fast fertig: Feinschliff, Sprache, Logik\n🔍 DIAGNOSTIC — Gezielte Analyse: ein spezifisches Problem benennen\n\nGib die Phase an und füge deinen Text mit @[[Notiz]] ein.",
    },
    {
      label: "Monthly Check",
      filePath: "Schreibdenken/ferals/Code/Prompts/MONTHLY COHERENCE AUDIT",
      searchMode: "date",
      searchFolders: ["Schreibdenken/ferals/Content/Artikel"],
    },
  ],
};

export const MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6 (Stärkste)" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Empfohlen)" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (Schnell)" },
];

export class MemexChatSettingsTab extends PluginSettingTab {
  plugin: MemexChatPlugin;

  constructor(app: App, plugin: MemexChatPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Sorted vault folder list — used by all folder autocompletes in this settings page
    const allFolders = this.app.vault.getAllFolders()
      .map((f) => f.path)
      .filter((p) => p !== "/")
      .sort();

    /** Attaches a folder-search dropdown to a wrapper element. onPick is called with the selected folder. */
    const attachFolderDropdown = (
      wrap: HTMLElement,
      input: HTMLInputElement,
      getExcluded: () => string[],
      onPick: (folder: string) => void,
    ) => {
      const dropdown = wrap.createDiv("vc-folder-dropdown");
      dropdown.style.display = "none";
      const refresh = () => {
        const q = input.value.toLowerCase();
        const excluded = getExcluded();
        const matches = allFolders
          .filter((f) => f.toLowerCase().includes(q) && !excluded.includes(f))
          .slice(0, 12);
        dropdown.empty();
        if (!matches.length) { dropdown.style.display = "none"; return; }
        for (const f of matches) {
          const item = dropdown.createDiv("vc-folder-item");
          item.textContent = f;
          item.addEventListener("mousedown", (e) => { e.preventDefault(); onPick(f); });
        }
        dropdown.style.display = "block";
      };
      input.addEventListener("input", refresh);
      input.addEventListener("focus", refresh);
      input.addEventListener("blur", () => setTimeout(() => { dropdown.style.display = "none"; }, 150));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { dropdown.style.display = "none"; input.blur(); }
      });
    };

    containerEl.createEl("h2", { text: "Memex Chat Einstellungen" });

    containerEl.createEl("p", {
      text: `Memex Chat v${this.plugin.manifest.version}`,
      cls: "setting-item-description",
    });

    // --- API ---
    containerEl.createEl("h3", { text: "Claude API" });

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("Dein Anthropic API Key (sk-ant-...)")
      .addText((text) =>
        text
          .setPlaceholder("sk-ant-api03-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    let modelDrop: DropdownComponent;
    let refreshBtn: ButtonComponent;

    new Setting(containerEl)
      .setName("Modell")
      .setDesc("Welches Claude-Modell verwenden?")
      .addDropdown((drop) => {
        modelDrop = drop;
        for (const m of MODELS) drop.addOption(m.id, m.name);
        drop.setValue(this.plugin.settings.model).onChange(async (value) => {
          this.plugin.settings.model = value;
          await this.plugin.saveSettings();
        });
      })
      .addButton((btn) => {
        refreshBtn = btn;
        btn.setButtonText("Aktualisieren").onClick(async () => {
          const prev = modelDrop.getValue();
          refreshBtn.setDisabled(true);
          refreshBtn.setButtonText("...");
          try {
            const models = await this.plugin.claude.fetchModels(this.plugin.settings.apiKey);
            modelDrop.selectEl.empty();
            for (const m of models) modelDrop.addOption(m.id, m.name);
            modelDrop.setValue(prev);
            this.plugin.settings.model = modelDrop.getValue();
            await this.plugin.saveSettings();
          } catch (err) {
            new Notice("Modelle konnten nicht geladen werden: " + (err as Error).message);
          } finally {
            refreshBtn.setDisabled(false);
            refreshBtn.setButtonText("Aktualisieren");
          }
        });
      });

    new Setting(containerEl)
      .setName("Max. Antwort-Tokens")
      .setDesc("Maximale Länge der Claude-Antwort. Für lange Analysen (z.B. Monthly Check) höher einstellen. (1024–16000)")
      .addSlider((slider) =>
        slider
          .setLimits(1024, 16000, 512)
          .setValue(this.plugin.settings.maxTokens)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxTokens = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Senden mit Enter")
      .setDesc("Ein: Enter sendet. Aus: Cmd+Enter sendet (Enter = neue Zeile)")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.sendOnEnter).onChange(async (value) => {
          this.plugin.settings.sendOnEnter = value;
          await this.plugin.saveSettings();
        })
      );

    // --- Semantic Search ---
    containerEl.createEl("h3", { text: "Semantische Suche (Embeddings)" });
    containerEl.createEl("p", {
      text: "Ersetzt TF-IDF durch ein lokales KI-Modell (Transformers.js). Das Modell wird beim ersten Einsatz von HuggingFace heruntergeladen und dann lokal gecacht. WASM-Laufzeit wird einmalig vom CDN geladen.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Semantische Suche aktivieren")
      .setDesc("Nutzt lokale Embeddings für kontextbasierte Ähnlichkeitssuche statt TF-IDF")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.useEmbeddings).onChange(async (value) => {
          this.plugin.settings.useEmbeddings = value;
          await this.plugin.saveSettings();
          await this.plugin.initEmbedSearch();
        })
      );

    new Setting(containerEl)
      .setName("Embedding-Modell")
      .setDesc("Welches Modell für die semantische Suche verwenden? Kleiner = schneller, größer = besser.")
      .addDropdown((drop) => {
        for (const m of EMBEDDING_MODELS) drop.addOption(m.id, m.name);
        drop.setValue(this.plugin.settings.embeddingModel).onChange(async (value) => {
          this.plugin.settings.embeddingModel = value;
          await this.plugin.saveSettings();
          await this.plugin.initEmbedSearch();
        });
      });

    // Exclude folders from embedding
    const exclSetting = new Setting(containerEl)
      .setName("Ordner ausschließen")
      .setDesc("Diese Ordner werden beim Embedding übersprungen. Nach Änderung Index neu aufbauen.");
    exclSetting.settingEl.style.flexWrap = "wrap";
    exclSetting.settingEl.style.alignItems = "flex-start";

    const exclTagContainer = exclSetting.controlEl.createDiv("vc-prop-tags");
    const renderExclTags = () => {
      exclTagContainer.empty();
      for (const folder of this.plugin.settings.embedExcludeFolders) {
        const tag = exclTagContainer.createEl("span", { cls: "vc-prop-tag" });
        tag.createEl("span", { text: folder });
        const x = tag.createEl("button", { cls: "vc-prop-tag-remove", text: "×" });
        x.onclick = async () => {
          this.plugin.settings.embedExcludeFolders =
            this.plugin.settings.embedExcludeFolders.filter((f) => f !== folder);
          await this.plugin.saveSettings();
          renderExclTags();
        };
      }
    };
    renderExclTags();

    const exclWrap = exclSetting.controlEl.createDiv("vc-folder-search-wrap");
    const exclInput = exclWrap.createEl("input", {
      cls: "vc-prop-input",
      attr: { type: "text", placeholder: "Ordner suchen…" },
    }) as HTMLInputElement;

    const addExclFolder = async (folder: string) => {
      folder = folder.trim().replace(/\/$/, "");
      if (!folder || this.plugin.settings.embedExcludeFolders.includes(folder)) return;
      this.plugin.settings.embedExcludeFolders = [...this.plugin.settings.embedExcludeFolders, folder];
      await this.plugin.saveSettings();
      exclInput.value = "";
      renderExclTags();
    };
    attachFolderDropdown(exclWrap, exclInput,
      () => this.plugin.settings.embedExcludeFolders,
      (f) => addExclFolder(f),
    );
    exclInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addExclFolder(exclInput.value); }
    });

    // --- Context ---
    containerEl.createEl("h3", { text: "Kontext-Einstellungen" });

    new Setting(containerEl)
      .setName("Max. Kontext-Notizen")
      .setDesc("Wie viele Notizen werden automatisch als Kontext hinzugefügt? (1–15)")
      .addSlider((slider) =>
        slider
          .setLimits(1, 15, 1)
          .setValue(this.plugin.settings.maxContextNotes)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxContextNotes = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max. Zeichen pro Notiz")
      .setDesc("Wie viele Zeichen einer Notiz in den Kontext einbezogen werden (1000–8000)")
      .addSlider((slider) =>
        slider
          .setLimits(1000, 8000, 500)
          .setValue(this.plugin.settings.maxCharsPerNote)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxCharsPerNote = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Automatischer Kontext-Abruf")
      .setDesc("Beim Senden automatisch relevante Notizen suchen und einbinden")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoRetrieveContext).onChange(async (value) => {
          this.plugin.settings.autoRetrieveContext = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Kontext-Vorschau anzeigen")
      .setDesc("Vor dem Senden zeigen, welche Notizen als Kontext verwendet werden")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showContextPreview).onChange(async (value) => {
          this.plugin.settings.showContextPreview = value;
          await this.plugin.saveSettings();
        })
      );

    // --- Priority Properties ---
    containerEl.createEl("h3", { text: "Prioritäts-Properties" });
    containerEl.createEl("p", {
      text: "Frontmatter-Properties, deren Werte bei der Kontextsuche stärker gewichtet werden (z.B. related, collection, up, tags). Nach Änderung den Index neu aufbauen.",
      cls: "setting-item-description",
    });

    const propSetting = new Setting(containerEl).setName("Properties");
    propSetting.settingEl.style.flexWrap = "wrap";
    propSetting.settingEl.style.alignItems = "flex-start";

    // Tag container
    const tagContainer = propSetting.controlEl.createDiv("vc-prop-tags");
    const renderTags = () => {
      tagContainer.empty();
      for (const prop of this.plugin.settings.contextProperties) {
        const tag = tagContainer.createEl("span", { cls: "vc-prop-tag" });
        tag.createEl("span", { text: prop });
        const removeBtn = tag.createEl("button", { cls: "vc-prop-tag-remove", text: "×" });
        removeBtn.onclick = async () => {
          this.plugin.settings.contextProperties = this.plugin.settings.contextProperties.filter(
            (p) => p !== prop
          );
          await this.plugin.saveSettings();
          renderTags();
        };
      }
    };
    renderTags();

    // Add input row
    const addRow = propSetting.controlEl.createDiv("vc-prop-add-row");
    const addInput = addRow.createEl("input", {
      cls: "vc-prop-input",
      attr: { type: "text", placeholder: "Property hinzufügen…" },
    }) as HTMLInputElement;
    const addBtn = addRow.createEl("button", { cls: "vc-prop-add-btn", text: "+" });

    const doAdd = async () => {
      const val = addInput.value.trim().toLowerCase();
      if (!val || this.plugin.settings.contextProperties.includes(val)) return;
      this.plugin.settings.contextProperties = [...this.plugin.settings.contextProperties, val];
      await this.plugin.saveSettings();
      addInput.value = "";
      renderTags();
    };
    addBtn.onclick = doAdd;
    addInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); doAdd(); }
    });

    // --- Prompt Buttons ---
    containerEl.createEl("h3", { text: "Prompt-Buttons" });
    containerEl.createEl("p", {
      text: "Buttons in der Chat-Leiste, die den System-Prompt um den Inhalt einer Vault-Notiz erweitern.",
      cls: "setting-item-description",
    });

    const btnListEl = containerEl.createDiv("vc-pbtn-list");
    const renderBtnList = () => {
      btnListEl.empty();
      for (const [idx, pb] of this.plugin.settings.promptButtons.entries()) {
        const card = btnListEl.createDiv("vc-pbtn-card");

        // ── Row 1: label / path / remove ──
        const row1 = card.createDiv("vc-pbtn-row");
        const labelInput = row1.createEl("input", {
          cls: "vc-pbtn-input",
          attr: { type: "text", placeholder: "Label", value: pb.label },
        }) as HTMLInputElement;
        labelInput.addEventListener("change", async () => {
          this.plugin.settings.promptButtons[idx].label = labelInput.value.trim();
          await this.plugin.saveSettings();
        });

        const pathInput = row1.createEl("input", {
          cls: "vc-pbtn-input vc-pbtn-path",
          attr: { type: "text", placeholder: "Pfad im Vault (ohne .md)", value: pb.filePath },
        }) as HTMLInputElement;
        pathInput.addEventListener("change", async () => {
          this.plugin.settings.promptButtons[idx].filePath = pathInput.value.trim();
          await this.plugin.saveSettings();
        });

        const removeBtn = row1.createEl("button", { cls: "vc-prop-tag-remove", text: "×" });
        removeBtn.style.fontSize = "16px";
        removeBtn.onclick = async () => {
          this.plugin.settings.promptButtons.splice(idx, 1);
          await this.plugin.saveSettings();
          renderBtnList();
        };

        // ── Row 2: date-search toggle + folders ──
        const row2 = card.createDiv("vc-pbtn-row2");
        const toggleWrap = row2.createEl("label", { cls: "vc-pbtn-toggle-wrap" });
        const checkbox = toggleWrap.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
        checkbox.checked = pb.searchMode === "date";
        toggleWrap.appendText(" Datumsbasierte Suche");

        const folderSection = row2.createDiv("vc-pbtn-folders");
        folderSection.style.display = pb.searchMode === "date" ? "flex" : "none";

        const renderFolders = () => {
          folderSection.empty();
          folderSection.createEl("span", { text: "Ordner: ", cls: "vc-pbtn-folder-label" });
          for (const folder of (pb.searchFolders ?? [])) {
            const chip = folderSection.createEl("span", { cls: "vc-prop-tag" });
            chip.createEl("span", { text: folder });
            const x = chip.createEl("button", { cls: "vc-prop-tag-remove", text: "×" });
            x.onclick = async () => {
              pb.searchFolders = (pb.searchFolders ?? []).filter((f) => f !== folder);
              await this.plugin.saveSettings();
              renderFolders();
            };
          }
          const folderWrap = folderSection.createDiv("vc-folder-search-wrap");
          folderWrap.style.width = "200px";
          const folderInput = folderWrap.createEl("input", {
            cls: "vc-pbtn-input",
            attr: { type: "text", placeholder: "Ordner suchen…" },
          }) as HTMLInputElement;
          const doAddFolder = async (val: string) => {
            val = val.trim().replace(/\/$/, "");
            if (!val || (pb.searchFolders ?? []).includes(val)) return;
            pb.searchFolders = [...(pb.searchFolders ?? []), val];
            await this.plugin.saveSettings();
            renderFolders();
          };
          attachFolderDropdown(folderWrap, folderInput, () => pb.searchFolders ?? [], (f) => doAddFolder(f));
          folderInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); doAddFolder(folderInput.value); }
          });
        };
        renderFolders();

        checkbox.addEventListener("change", async () => {
          pb.searchMode = checkbox.checked ? "date" : undefined;
          if (!checkbox.checked) pb.searchFolders = [];
          folderSection.style.display = checkbox.checked ? "flex" : "none";
          await this.plugin.saveSettings();
        });

        // ── Row 3: help text ──
        const helpLabel = card.createEl("label", { cls: "vc-pbtn-folder-label", text: "Hilfetext (optional, erscheint im Chat wenn Button aktiv):" });
        const helpTextArea = card.createEl("textarea", {
          cls: "vc-pbtn-help-textarea",
          attr: { placeholder: "z.B. DRAFT — Frühphase…\nPRE-PUBLISH — Fast fertig…" },
        }) as HTMLTextAreaElement;
        helpTextArea.value = pb.helpText ?? "";
        // 1 row when empty, auto-fit to content when filled
        const updateHelpRows = () => {
          const lines = helpTextArea.value.split("\n").length;
          helpTextArea.rows = helpTextArea.value.trim() ? Math.max(2, lines) : 1;
        };
        updateHelpRows();
        helpTextArea.addEventListener("input", updateHelpRows);
        helpTextArea.addEventListener("change", async () => {
          pb.helpText = helpTextArea.value.trim() || undefined;
          await this.plugin.saveSettings();
        });
      }

      // ── Add row ──
      const addRow = btnListEl.createDiv("vc-pbtn-add-row");
      const newLabel = addRow.createEl("input", {
        cls: "vc-pbtn-input",
        attr: { type: "text", placeholder: "Label (z.B. Draft Check)" },
      }) as HTMLInputElement;
      const newPath = addRow.createEl("input", {
        cls: "vc-pbtn-input vc-pbtn-path",
        attr: { type: "text", placeholder: "Pfad/zur/Prompt-Notiz" },
      }) as HTMLInputElement;
      const addBtn = addRow.createEl("button", { cls: "vc-prop-add-btn", text: "+" });
      addBtn.onclick = async () => {
        const label = newLabel.value.trim();
        const filePath = newPath.value.trim();
        if (!label || !filePath) return;
        this.plugin.settings.promptButtons.push({ label, filePath });
        await this.plugin.saveSettings();
        renderBtnList();
      };
    };
    renderBtnList();

    // --- Threads ---
    containerEl.createEl("h3", { text: "Thread-History" });

    new Setting(containerEl)
      .setName("Threads im Vault speichern")
      .setDesc("Chat-Threads als Markdown-Notizen im Vault ablegen")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.saveThreadsToVault).onChange(async (value) => {
          this.plugin.settings.saveThreadsToVault = value;
          await this.plugin.saveSettings();
        })
      );

    const threadsFolderSetting = new Setting(containerEl)
      .setName("Threads-Ordner")
      .setDesc("Pfad im Vault, wo Chat-Threads gespeichert werden");
    const tfWrap = threadsFolderSetting.controlEl.createDiv("vc-folder-search-wrap");
    const tfInput = tfWrap.createEl("input", {
      cls: "vc-prop-input",
      attr: { type: "text", placeholder: "Calendar/Chat" },
    }) as HTMLInputElement;
    tfInput.value = this.plugin.settings.threadsFolder;
    tfInput.addEventListener("input", async () => {
      this.plugin.settings.threadsFolder = tfInput.value;
      await this.plugin.saveSettings();
    });
    attachFolderDropdown(tfWrap, tfInput, () => [], async (f) => {
      tfInput.value = f;
      this.plugin.settings.threadsFolder = f;
      await this.plugin.saveSettings();
    });

    // --- System Prompt ---
    containerEl.createEl("h3", { text: "System Prompt" });

    new Setting(containerEl)
      .setName("System Prompt")
      .setDesc("Instruktionen für Claude (wie soll er sich verhalten?)")
      .addTextArea((textarea) => {
        textarea
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
        textarea.inputEl.rows = 8;
        textarea.inputEl.style.width = "100%";
        textarea.inputEl.style.fontFamily = "monospace";
        textarea.inputEl.style.fontSize = "12px";
      });

    new Setting(containerEl)
      .setName("System Context (Datei)")
      .setDesc("Optionale Vault-Notiz, deren Inhalt an den System Prompt angehängt wird (Pfad ohne .md)")
      .addText((text) =>
        text
          .setPlaceholder("z.B. Prompts/Mein System Context")
          .setValue(this.plugin.settings.systemContextFile)
          .onChange(async (value) => {
            this.plugin.settings.systemContextFile = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // --- Actions ---
    containerEl.createEl("h3", { text: "Aktionen" });

    new Setting(containerEl)
      .setName("Index neu aufbauen")
      .setDesc("Vault-Index neu aufbauen (TF-IDF oder Embedding-Index, je nach Einstellung)")
      .addButton((btn) =>
        btn
          .setButtonText("Index neu aufbauen")
          .setCta()
          .onClick(async () => {
            btn.setButtonText("Indiziere…");
            btn.setDisabled(true);
            await this.plugin.rebuildIndex();
            btn.setButtonText("✓ Fertig!");
            setTimeout(() => {
              btn.setButtonText("Index neu aufbauen");
              btn.setDisabled(false);
            }, 2000);
          })
      );
  }
}
