import { requestUrl } from "obsidian";

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ClaudeOptions {
  apiKey: string;
  model: string;
  maxTokens?: number;
  systemPrompt: string;
}

export interface ClaudeStreamChunk {
  type: "text" | "done" | "error";
  text?: string;
  error?: string;
}

/** Minimal Claude API client using Obsidian's requestUrl (bypasses CORS) */
export class ClaudeClient {
  private baseUrl = "https://api.anthropic.com/v1/messages";

  private headers(apiKey: string): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  /**
   * "Stream" a chat completion via requestUrl (no real streaming — CORS blocks
   * native fetch from app://obsidian.md). Yields the full response as a single
   * text chunk so ChatView's streaming loop keeps working unchanged.
   */
  async *streamChat(
    messages: ClaudeMessage[],
    options: ClaudeOptions
  ): AsyncGenerator<ClaudeStreamChunk> {
    const response = await requestUrl({
      url: this.baseUrl,
      method: "POST",
      headers: this.headers(options.apiKey),
      body: JSON.stringify({
        model: options.model,
        max_tokens: options.maxTokens ?? 8192,
        system: options.systemPrompt,
        messages,
      }),
      throw: false,
    });

    if (response.status >= 400) {
      yield { type: "error", error: `API Error ${response.status}: ${response.text}` };
      return;
    }

    const text: string = response.json.content?.[0]?.text ?? "";
    yield { type: "text", text };
    yield { type: "done" };
  }

  /** Non-streaming convenience wrapper */
  async chat(messages: ClaudeMessage[], options: ClaudeOptions): Promise<string> {
    const response = await requestUrl({
      url: this.baseUrl,
      method: "POST",
      headers: this.headers(options.apiKey),
      body: JSON.stringify({
        model: options.model,
        max_tokens: options.maxTokens ?? 8192,
        system: options.systemPrompt,
        messages,
      }),
      throw: false,
    });

    if (response.status >= 400) {
      throw new Error(`API Error ${response.status}: ${response.text}`);
    }

    return response.json.content?.[0]?.text ?? "";
  }

  /**
   * Fetch Claude models from the Anthropic Models API.
   * Returns the 2 newest versions of each family (opus, sonnet, haiku), in that order.
   */
  async fetchModels(apiKey: string): Promise<{ id: string; name: string }[]> {
    const response = await requestUrl({
      url: "https://api.anthropic.com/v1/models",
      method: "GET",
      headers: this.headers(apiKey),
      throw: false,
    });

    if (response.status >= 400) {
      throw new Error(`API Error ${response.status}: ${response.text}`);
    }

    const data: { id: string; created: number }[] = response.json.data ?? [];
    if (data.length === 0) {
      throw new Error("No models returned");
    }

    const sorted = data.sort((a, b) => b.created - a.created);
    const families = ["opus", "sonnet", "haiku"] as const;
    return families.flatMap((family) =>
      sorted
        .filter((m) => m.id.includes(family))
        .slice(0, 2)
        .map((m) => ({ id: m.id, name: m.id }))
    );
  }
}
