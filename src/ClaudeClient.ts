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

/** Minimal Claude API client. streamChat uses fetch+SSE; other methods use requestUrl. */
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
   * Stream a chat completion via XHR + SSE, yielding text chunks as they arrive.
   * Uses XHR instead of fetch because Obsidian patches the global fetch in a way
   * that buffers the full response, breaking streaming.
   */
  async *streamChat(
    messages: ClaudeMessage[],
    options: ClaudeOptions
  ): AsyncGenerator<ClaudeStreamChunk> {
    const queue: ClaudeStreamChunk[] = [];
    let done = false;
    let wakeup: (() => void) | null = null;

    const push = (c: ClaudeStreamChunk) => { queue.push(c); wakeup?.(); wakeup = null; };
    const finish = () => { done = true; wakeup?.(); wakeup = null; };

    const xhr = new XMLHttpRequest();
    xhr.open("POST", this.baseUrl, true);
    for (const [k, v] of Object.entries(this.headers(options.apiKey))) {
      xhr.setRequestHeader(k, v);
    }

    // Parse SSE lines from xhr.responseText; linesCursor avoids reprocessing old lines.
    let linesCursor = 0;
    const parseSse = (allDone: boolean) => {
      const lines = xhr.responseText.split("\n");
      const limit = allDone ? lines.length : lines.length - 1; // skip last (may be partial)
      for (let i = linesCursor; i < limit; i++) {
        const line = lines[i];
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;
        try {
          const ev = JSON.parse(data);
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            push({ type: "text", text: ev.delta.text });
          }
        } catch { /* skip malformed lines */ }
      }
      linesCursor = limit;
    };

    xhr.onprogress = () => parseSse(false);
    xhr.onload = () => {
      if (xhr.status >= 400) {
        push({ type: "error", error: `API Error ${xhr.status}: ${xhr.responseText}` });
      } else {
        parseSse(true);
      }
      finish();
    };
    xhr.onerror = () => { push({ type: "error", error: "Network error" }); finish(); };
    xhr.ontimeout = () => { push({ type: "error", error: "Request timed out" }); finish(); };

    xhr.send(JSON.stringify({
      model: options.model,
      max_tokens: options.maxTokens ?? 8192,
      system: options.systemPrompt,
      messages,
      stream: true,
    }));

    while (true) {
      while (queue.length) yield queue.shift()!;
      if (done) break;
      await new Promise<void>(r => { wakeup = r; });
    }
    while (queue.length) yield queue.shift()!;
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
