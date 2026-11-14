import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");

describe("production Node and SDK runtime", () => {
  it("uses the pinned Node 24 image in both Dockerfile stages", () => {
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    expect(dockerfile.match(/^FROM node:24\.22\.3-slim.*$/gm)).toHaveLength(2);
  });

  it("declares Node >= 24 and the SDK as a production dependency", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.engines.node).toBe(">=24");
    expect(pkg.dependencies["@opencode/sdk"]).toBe("2.3.0");
    // The SDK packages peer-depend on effect 4.1.0; pinning it at the root
    // keeps npm from hoisting Prisma's effect 3.21.0 into their peer slot.
    expect(pkg.dependencies.effect).toBe("4.1.0");
    expect(pkg.devDependencies?.["@opencode/sdk"]).toBeUndefined();
  });
});
