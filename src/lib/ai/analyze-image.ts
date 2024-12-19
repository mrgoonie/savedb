import { z } from "zod";

import { type AskAiResponse, fetchAi, VisionModelSchema } from "./fetch-ai";
import { validateJson } from "./json-validator";

export const AnalyzeImageSchema = z.object({
  image: z.string().describe("The image url to analyze"),
  systemPrompt: z.string().optional().describe("A prompt for the AI to follow"),
  instructions: z.string().optional().describe("Additional instructions for the AI"),
});

export type AnalyzeImageInput = z.infer<typeof AnalyzeImageSchema>;

export const AnalyzeImageOptionsSchema = z
  .object({
    model: VisionModelSchema.optional().describe("The AI model to use"),
    jsonResponseFormat: z.string().optional().describe("A JSON response format for the AI"),
  })
  .optional();

export type AnalyzeImageOptions = z.infer<typeof AnalyzeImageOptionsSchema>;

const DEFAULT_JSON_RESPONSE_FORMAT = JSON.stringify(
  {
    elements: [{ type: "string" }],
    properties: {
      description: { type: "string" },
      analysis: { type: "string" },
    },
  },
  null,
  2
);

export async function analyzeImage(input: AnalyzeImageInput, options?: AnalyzeImageOptions) {
  // validate input
  const validatedInput = AnalyzeImageSchema.parse(input);
  const validatedOptions = AnalyzeImageOptionsSchema.parse(options);

  const systemPrompt = validatedInput.systemPrompt ?? `You are an AI image analysis tool.`;
  const instructions =
    validatedInput.instructions ??
    `Analyze the image following these instructions:
  ## Instructions:
  - Return a JSON object based on this format:
  ## JSON Response Format:
  ${validatedOptions?.jsonResponseFormat ?? DEFAULT_JSON_RESPONSE_FORMAT}`;

  const response = (await fetchAi({
    model: validatedOptions?.model ?? "google/gemini-flash-1.5",
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: instructions },
          { type: "image_url", image_url: validatedInput.image },
        ],
      },
    ],
  })) as AskAiResponse;

  const responseContent = response.choices[0].message.content;
  if (!responseContent)
    throw new Error(response.choices[0].error?.message ?? "No response content found");

  const data = await validateJson(responseContent, {
    maxRetries: 5,
    parse: true,
  });

  return { data, usage: response.usage, model: response.model };
}

export async function analyzeImageBase64(
  params: {
    base64: string;
    instructions?: string;
    systemPrompt?: string;
  },
  options?: AnalyzeImageOptions
) {
  const { base64, instructions, systemPrompt } = params;
  const image = `data:image/png;base64,${base64}`;
  return analyzeImage({ image, instructions, systemPrompt }, options);
}