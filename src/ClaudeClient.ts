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

/** Minimal Claude API client */
export class ClaudeClient {
  private baseUrl = "https://api.anthropic.com/v1/messages";

  private headers(apiKey: string): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  /** Stream a chat completion, yielding text chunks */
  async *streamChat(
    messages: ClaudeMessage[],
    options: ClaudeOptions
  ): AsyncGenerator<ClaudeStreamChunk> {
    // Use native fetch for streaming (requestUrl doesn't support streaming).
    // The outdated anthropic-beta header is omitted — streaming is stable API.
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: this.headers(options.apiKey),
      body: JSON.stringify({
        model: options.model,
        max_tokens: options.maxTokens ?? 2048,
        stream: true,
        system: options.systemPrompt,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      yield { type: "error", error: `API Error ${response.status}: ${err}` };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: "error", error: "No response body" };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          yield { type: "done" };
          return;
        }
        try {
          const json = JSON.parse(data);
          if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
            yield { type: "text", text: json.delta.text };
          } else if (json.type === "message_stop") {
            yield { type: "done" };
            return;
          } else if (json.type === "error") {
            yield { type: "error", error: json.error?.message ?? "Unknown error" };
            return;
          }
        } catch {
          // skip malformed lines
        }
      }
    }
    yield { type: "done" };
  }

  /** Non-streaming version — uses Obsidian's requestUrl to bypass CORS */
  async chat(messages: ClaudeMessage[], options: ClaudeOptions): Promise<string> {
    const response = await requestUrl({
      url: this.baseUrl,
      method: "POST",
      headers: this.headers(options.apiKey),
      body: JSON.stringify({
        model: options.model,
        max_tokens: options.maxTokens ?? 2048,
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
}
