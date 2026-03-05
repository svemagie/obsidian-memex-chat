# Memex Chat — Obsidian Plugin

Chat with your Obsidian vault using Claude AI. Semantic context retrieval, `@` mentions, thread history, local embeddings, and a related notes sidebar.

## Features

- **Semantic vault search** — TF-IDF index over all your notes, no external API needed for retrieval
- **Local embeddings** — optional on-device semantic search using `@xenova/transformers` (BGE Micro v2), fully offline after first model download
- **Related notes sidebar** — panel showing the most similar notes to whatever you have open, ranked by semantic similarity + frontmatter links + shared tags
- **Auto context** — relevant notes are automatically found and sent to Claude as context
- **Context preview** — see and edit which notes are included before sending
- **`@Notizname` mentions** — reference specific notes directly in your message with autocomplete
- **Thread history** — chats saved as Markdown in your vault (default: `Calendar/Chat/`)
- **Streaming responses** — Claude's answer appears token by token
- **Source links** — every answer shows which notes were used
- **Prompt buttons** — header mode buttons that extend Claude's system prompt (e.g. draft check, monthly review)

## Installation

1. Download `main.js`, `manifest.json`, `styles.css` from the [latest release](../../releases/latest)
2. Copy into `.obsidian/plugins/memex-chat/` in your vault
3. Enable in **Settings → Community Plugins → Memex Chat**
4. Add your [Anthropic API key](https://console.anthropic.com/) in plugin settings

## Build from Source

```bash
npm install
npm run build
```

Requires Node 18+.

## Settings

### General

| Setting | Default | Description |
|---|---|---|
| API Key | — | Your Anthropic API key |
| Model | claude-opus-4-5 | Which Claude model to use |
| Max context notes | 6 | How many notes to retrieve per query |
| Max chars per note | 2500 | How much of each note to include |
| Auto retrieve context | on | Automatically find relevant notes on send |
| Context preview | on | Show context before sending |
| Save threads to vault | on | Persist chats as Markdown files |
| Threads folder | `Calendar/Chat` | Where to save thread files |
| Send on Enter | off | Enter sends (vs. Cmd+Enter) |
| Context properties | collection, related, up, tags | Frontmatter properties boosted in search ranking |

### Embeddings (optional)

| Setting | Default | Description |
|---|---|---|
| Use embeddings | off | Enable local semantic search instead of TF-IDF |
| Embedding model | BGE Micro v2 | ONNX model for local inference |
| Exclude folders | — | Vault folders skipped during embedding |

When enabled, embeddings are computed locally (no API call) and cached in `<vault>/.memex-chat/embeddings/`. The model (~22 MB) is downloaded once to `<vault>/.memex-chat/models/`. Indexing progress is shown as an Obsidian notice. Obsidian Sync activity is detected automatically and indexing waits until sync is idle.

## Commands

| Command | Description |
|---|---|
| `Memex Chat öffnen` | Open the chat panel |
| `Verwandte Notizen` | Open the related notes sidebar |
| `Memex Chat: Index neu aufbauen` | Rebuild the search index |
| `Memex Chat: Aktive Notiz als Kontext` | Ask Claude about the currently open note |

## Related Notes Sidebar

Opens in the right sidebar and automatically shows the top 10 most similar notes to the currently active file. Similarity is computed from:

1. **Semantic embedding similarity** (cosine distance on 384-dim vectors)
2. **+0.15 boost** for notes linked via `contextProperties` frontmatter fields (e.g. `related: [[Note]]`)
3. **+0.05 per shared tag** (up to +0.15)

Notes explicitly linked via frontmatter are marked with a **verknüpft** badge.

## License

MIT
