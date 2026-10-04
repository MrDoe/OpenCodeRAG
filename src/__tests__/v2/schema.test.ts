import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { zodArgToJsonSchema, zodShapeToJsonSchema } from "../../v2/v2-adapter.js";

describe("zodArgToJsonSchema", () => {
  it("converts enums to string enums", () => {
    assert.deepEqual(zodArgToJsonSchema(z.enum(["choice", "noul", "score"])), {
      type: "string",
      enum: ["choice", "noul", "score"],
    });
  });

  it("converts records to objects with additionalProperties", () => {
    assert.deepEqual(zodArgToJsonSchema(z.record(z.string(), z.string())), {
      type: "object",
      additionalProperties: { type: "string" },
    });
  });

  it("converts unions to anyOf", () => {
    assert.deepEqual(zodArgToJsonSchema(z.union([z.string(), z.array(z.string())])), {
      anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    });
  });

  it("unwraps optional wrappers", () => {
    assert.deepEqual(zodArgToJsonSchema(z.string().optional()), { type: "string" });
  });

  it("converts the make_decision args shape with nested criteria", () => {
    const shape = {
      state: z.string().min(1),
      questions: z
        .array(
          z.object({
            id: z.string().min(1),
            type: z.enum(["choice", "noul", "score"]),
            instructions: z.string().min(1),
            criteria: z
              .union([
                z.record(z.string(), z.string()),
                z.array(z.string()),
                z.object({ true: z.string().optional(), false: z.string().optional() }),
              ])
              .optional(),
          })
        )
        .min(1)
        .max(64),
    };

    const json = zodShapeToJsonSchema(shape as unknown as Record<string, unknown>);
    assert.equal(json.type, "object");
    assert.deepEqual(json.required, ["state", "questions"]);

    const properties = json.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(properties.state, { type: "string" });

    const questions = properties.questions!;
    assert.equal(questions.type, "array");
    const items = questions.items as Record<string, unknown>;
    assert.equal(items.type, "object");
    assert.deepEqual(items.required, ["id", "type", "instructions"]);

    const itemProperties = items.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(itemProperties.type, { type: "string", enum: ["choice", "noul", "score"] });
    assert.deepEqual(itemProperties.criteria, {
      anyOf: [
        { type: "object", additionalProperties: { type: "string" } },
        { type: "array", items: { type: "string" } },
        { type: "object", properties: { true: { type: "string" }, false: { type: "string" } }, required: undefined },
      ],
    });
  });
});
