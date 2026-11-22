import { describe, expect, it } from "vitest";
import { contextTooLongExample, overloadedExample, unknownExample } from "./contract.example.js";
import { classifyErrorExplanation } from "./model.js";

describe("error-explanations 合同", () => {
  it("上下文过长优先于 HTTP 400 的泛化归类", () => {
    expect(classifyErrorExplanation(contextTooLongExample)).toBe("contextTooLong");
  });

  it("529 归类为过载", () => {
    expect(classifyErrorExplanation(overloadedExample)).toBe("overloaded");
  });

  it("归类不到时返回 undefined", () => {
    expect(classifyErrorExplanation(unknownExample)).toBeUndefined();
  });
});
