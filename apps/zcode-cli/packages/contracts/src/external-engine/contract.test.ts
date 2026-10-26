import { expect, test } from "vitest";
import { externalEngineContractModule } from "./module.js";
test("外部引擎契约只声明端口", () => {
  expect(externalEngineContractModule.provides).toEqual(["ExternalEnginePort"]);
});
