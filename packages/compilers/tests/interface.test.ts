import { describe, expect, it } from "vitest";

import { compileWorkflow, compilers } from "../src/index.js";
import { approvedWorkflow } from "./fixture.js";

describe("shared compiler interface", () => {
  it("exposes all three targets behind one compile contract", () => {
    expect(Object.keys(compilers)).toEqual(["playbook", "playwright", "computer-use"]);

    expect(compileWorkflow("playbook", approvedWorkflow()).files).toHaveLength(1);
    expect(compileWorkflow("playwright", approvedWorkflow()).files).toHaveLength(2);
    expect(compileWorkflow("computer-use", approvedWorkflow()).files.length).toBeGreaterThanOrEqual(4);
  });
});
