# Memex Chat — CLAUDE.md

Obsidian plugin: Chat with your vault using Claude AI. Semantic TF-IDF context retrieval, `@Notizname` mentions, thread history, prompt extension buttons, streaming responses.

## Build

```bash
npm install
npm run build   # production build → main.js
npm run dev     # watch mode with inline sourcemaps
```

Entry: `src/main.ts` → bundled to `main.js` via esbuild (CJS, ES2018 target).
`obsidian` and all `@codemirror/*` / `@lezer/*` packages are external (provided by Obsidian).

## Architecture

| File | Role |
|---|---|
| `src/main.ts` | Plugin entry — `MemexChatPlugin extends Plugin`. Registers view, commands, settings tab. Wires index rebuild and layout-ready hook. |
| `src/ChatView.ts` | Main UI — `ChatView extends ItemView`. Thread management, sidebar history, context preview, mode buttons, streaming render, Copy/Save actions. View type: `memex-chat-view`. |
| `src/VaultSearch.ts` | TF-IDF search engine. Builds in-memory index over all vault markdown files. Frontmatter property boost (5×). `findSimilarByName()` for unresolved link hints. |
| `src/ClaudeClient.ts` | Anthropic API client. `streamChat()` yields `ClaudeStreamChunk` via async generator. Uses Obsidian `requestUrl` (no SDK, bypasses CORS). |
| `src/SettingsTab.ts` | `MemexChatSettingsTab` + `MemexChatSettings` interface + `DEFAULT_SETTINGS`. Exports `PromptButton` interface. |
| `styles.css` | All plugin styles. CSS classes prefixed `vc-` (e.g. `vc-root`, `vc-msg--assistant`). |
| `manifest.json` | Obsidian plugin manifest. ID: `memex-chat`. Version: `0.2.3`. |
| `main.js` | Compiled output — do not edit manually, always rebuild. |

## Key Patterns

- **Data persistence**: `this.saveData(this.data)` / `this.loadData()` — single object `{ settings, threads }`. Settings merge on load preserves new fields via per-entry spread for `promptButtons`.
- **Streaming**: `ClaudeClient.streamChat()` is an async generator; `ChatView` iterates it and calls `updateLastMessage()` per chunk. (Note: `requestUrl` delivers the full response at once — no true streaming.)
- **Context flow**: Query → `VaultSearch.search()` → context preview → user confirms → `sendMessage()` injects note content into the Claude prompt. Auto-retrieve skipped when prompt extension buttons are active.
- **System prompt layering**: base system prompt → optional `systemContextFile` → active `promptButtons` extension files (each appended with `\n\n---\n`).
- **@mention syntax**: `@Notizname` — autocomplete triggers after 2 chars, inserts full basename. Parsing in `handleSend` matches vault filenames directly (handles spaces & special chars).
- **Prompt buttons**: `activeExtensions: Set<string>` tracks active button file paths. Mode hint panel shows `helpText` above input; hidden after send. Date-search buttons parse month from query and filter files by `getFileDate()`.
- **Thread sidebar**: Inline rename (double-click title). Collapsible "Verlauf" section loads vault chat files not in active threads via `parseThreadFromVault()`.
- **Thread storage**: Optionally saved as Markdown to `threadsFolder` (default `Calendar/Chat/`). Filename: `YYYYMMDDHHmmss Title.md`. Frontmatter includes `id:` for dedup on re-import.
- **Message actions**: Copy (clipboard) and "Als Notiz" (save to Obsidian's default new-note folder) appear on hover for finished assistant messages.
- **Unresolved links**: `is-unresolved` class + inline "Ähnliche Notiz: X" hint via `findSimilarByName()`.
- **History cap**: Last 10 messages sent to API per request.
- **CSS prefix**: `vc-` for all plugin DOM classes. Do not use Obsidian internal class names.
- **Event listeners**: Use `this.registerDomEvent()` for permanent listeners (auto-cleanup on view close). Inline `onclick` / `addEventListener` acceptable for dynamic elements that are re-created.
- **TypeScript**: `strictNullChecks` on, `moduleResolution: bundler`. No tests currently.

## Settings (MemexChatSettings)

| Field | Default | Description |
|---|---|---|
| `apiKey` | `""` | Anthropic API key |
| `model` | `claude-opus-4-5-20251101` | Claude model ID |
| `maxTokens` | `8192` | Max output tokens (1024–16000) |
| `maxContextNotes` | `6` | TF-IDF context notes per query |
| `maxCharsPerNote` | `2500` | Characters per context note |
| `systemPrompt` | (German default) | Base system instructions |
| `systemContextFile` | `""` | Optional vault note appended to system prompt |
| `autoRetrieveContext` | `true` | Auto-search on send |
| `showContextPreview` | `true` | Show context confirm step |
| `saveThreadsToVault` | `true` | Save chats as vault markdown files |
| `threadsFolder` | `Calendar/Chat` | Folder for saved threads |
| `sendOnEnter` | `false` | Enter sends (vs. Cmd+Enter) |
| `contextProperties` | `[collection, related, up, tags]` | Frontmatter props boosted 5× in TF-IDF |
| `promptButtons` | Draft Check, Monthly Check | Header mode buttons with system prompt extension |

## Prompt Buttons (PromptButton interface)

```typescript
interface PromptButton {
  label: string;
  filePath: string;        // vault path to prompt note (without .md)
  searchMode?: "date";     // enables date-based file search
  searchFolders?: string[]; // restrict date search to these folders
  helpText?: string;       // shown above input when button is active
}
```

## Deployment (Manual)

Copy `main.js`, `manifest.json`, `styles.css` into `.obsidian/plugins/memex-chat/` in the target vault.

## Models (SettingsTab.ts)

Default: `claude-opus-4-5-20251101`. Update `MODELS` array and `DEFAULT_SETTINGS.model` when adding new model IDs.
