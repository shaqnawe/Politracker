import OpenAI from "openai";
import { loadEnv } from "../env.js";
import { coerceExtraction, EXTRACTION_SCHEMA, SYSTEM_PROMPT, USER_INSTRUCTION } from "../prompt.js";
import type { ExtractedFiling, OcrProvider } from "../types.js";

/** OpenAI vision adapter — structured output via strict json_schema response format. */
export function createOpenAiProvider(): OcrProvider {
  loadEnv();
  const model = process.env.OPENAI_OCR_MODEL ?? "gpt-4o";
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  return {
    name: "openai",
    async extract(pageImages: Buffer[]): Promise<ExtractedFiling> {
      const content = [
        { type: "text" as const, text: USER_INSTRUCTION },
        ...pageImages.map((b) => ({
          type: "image_url" as const,
          image_url: { url: `data:image/png;base64,${b.toString("base64")}` },
        })),
      ];

      const res = await client.chat.completions.create({
        model,
        max_tokens: 16384,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "ptr_extraction", schema: EXTRACTION_SCHEMA as Record<string, unknown>, strict: true },
        },
      });

      const text = res.choices[0]?.message?.content ?? "{}";
      return coerceExtraction(JSON.parse(text));
    },
  };
}
