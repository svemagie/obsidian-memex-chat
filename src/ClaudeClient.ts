import { requestUrl } from "obsidian";
import * as https from "https";

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
   * Stream a chat completion via Node.js https + SSE, yielding text chunks as they arrive.
   * Uses the Node.js https module (available in Obsidian's Electron renderer via Node integration)
   * to bypass Electron's CORS/CSP restrictions that block fetch and XHR to external APIs.
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

    const body = JSON.stringify({
      model: options.model,
      max_tokens: options.maxTokens ?? 8192,
      system: options.systemPrompt,
      messages,
      stream: true,
    });

    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          ...this.headers(options.apiKey),
          "content-length": Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          let errBody = "";
          res.on("data", (d: Buffer) => errBody += d.toString());
          res.on("end", () => { push({ type: "error", error: `API Error ${res.statusCode}: ${errBody}` }); finish(); });
          return;
        }

        let buf = "";
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split("\n");
          buf = lines.pop() ?? ""; // keep partial last line
          for (const line of lines) {
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
        });

        res.on("end", () => { finish(); });
        res.on("error", (e: Error) => { push({ type: "error", error: e.message }); finish(); });
      }
    );

    req.on("error", (e: Error) => { push({ type: "error", error: e.message }); finish(); });
    req.write(body);
    req.end();

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
