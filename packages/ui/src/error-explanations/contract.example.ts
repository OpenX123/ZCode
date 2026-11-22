import type { ErrorExplanationInput } from "./contract.js";

/** 带 400 的上下文过长报错：应归类为 contextTooLong，而不是泛化错误。 */
export const contextTooLongExample = {
  httpStatus: 400,
  message: "prompt is too long: 210000 tokens > 200000 maximum",
} satisfies ErrorExplanationInput;

/** 529 过载。 */
export const overloadedExample = { httpStatus: 529 } satisfies ErrorExplanationInput;

/** 无法归类：调用方显示原摘要。 */
export const unknownExample = { message: "something odd happened" } satisfies ErrorExplanationInput;
