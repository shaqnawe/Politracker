import Anthropic from "@anthropic-ai/sdk";
import { loadEnv } from "../env.js";
import { coerceExtraction, EXTRACTION_SCHEMA, SYSTEM_PROMPT, USER_INSTRUCTION } from "../prompt.js";
import type { ExtractedFiling, OcrProvider } from "../types.js";

/** Claude vision adapter — structured output via a single forced tool call. */
export function createClaudeProvider(): OcrProvider {
  loadEnv();
  const model = process.env.ANTHROPIC_OCR_MODEL ?? "claude-sonnet-4-6";
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  return {
    name: "claude",
    async extract(pageImages: Buffer[]): Promise<ExtractedFiling> {
      const images = pageImages.map((b) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: "image/png" as const,
          data: b.toString("base64"),
        },
      }));

      const res = await client.messages.create({
        model,
        max_tokens: 16384,
        // Cache the (large, static) system prompt across calls.
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: [
          {
            name: "record_ptr",
            description: "Record the transcribed Periodic Transaction Report.",
            input_schema: EXTRACTION_SCHEMA as unknown as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: "tool", name: "record_ptr" },
        messages: [{ role: "user", content: [...images, { type: "text", text: USER_INSTRUCTION }] }],
      });

      const block = res.content.find((c) => c.type === "tool_use");
      if (!block || block.type !== "tool_use") throw new Error("claude: no tool_use block in response");
      return coerceExtraction(block.input);
    },
  };
}
