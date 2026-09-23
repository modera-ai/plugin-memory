import { expect, it } from "vitest";
import { parseExtractionResponse } from "../src/extraction-prompt";

it("accepts plain JSON and a complete JSON code block without changing the payload", () => {
  const payload = { memories: [{ text: "Keep literal ``` text", sourceId: "u" }] };
  for (const input of [JSON.stringify(payload), "```json\r\n" + JSON.stringify(payload) + "\r\n```", "```\n" + JSON.stringify(payload) + "\n```"])
    expect(parseExtractionResponse(input)).toEqual(payload);
});

it("rejects prose, multiple blocks, incomplete wrappers and malformed JSON", () => {
  for (const input of ['Here is the result: {"memories":[]}', '```json\n{"memories":[]}\n```\nextra', '```json\n{"memories":[]}', '```json\n{bad}\n```', '```json\n{}\n```\n```json\n{}\n```'])
    expect(() => parseExtractionResponse(input)).toThrow();
});
