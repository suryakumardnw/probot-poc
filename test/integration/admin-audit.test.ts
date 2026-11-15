import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { createPrismaAuditRepository } from "../../src/admin/prisma-audit.repository.js";
import { cleanDatabase, disconnectDatabase, prisma, silentLogger } from "../characterization/support.js";

/**
 * Integration: audit repository against real PostgreSQL.
 *
 * Admin requests depend on two outcomes: a write is durable before the request
 * succeeds, and the audit page reads newest-first pages with scalar JSON
 * metadata intact.
 */

const audit = createPrismaAuditRepository(prisma, silentLogger);

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectDatabase();
});

describe("audit repository", () => {
  test("records the actor, action, resource, and scalar metadata", async () => {
    await audit.record({
      actor: "octoadmin",
      action: "config.update",
      resource: "configuration",
      metadata: { previousHash: "sha256:old", nextHash: "sha256:new", dryRun: false },
    });

    const row = await prisma.auditLog.findFirst({ where: { actor: "octoadmin" } });
    expect(row).toMatchObject({
      actor: "octoadmin",
      action: "config.update",
      resource: "configuration",
      metadata: { previousHash: "sha256:old", nextHash: "sha256:new", dryRun: false },
    });
  });

  test("records an entry without metadata as a null column", async () => {
    await audit.record({ actor: "anonymous", action: "admin.login_denied", resource: "admin_session" });

    const row = await prisma.auditLog.findFirst({ where: { actor: "anonymous" } });
    expect(row?.metadata).toBeNull();
  });

  test("lists audit history newest-first with a stable total across pages", async () => {
    const now = Date.now();
    await prisma.auditLog.createMany({
      data: [
        {
          actor: "first",
          action: "admin.login",
          resource: "admin_session",
          createdAt: new Date(now - 3_000),
        },
        {
          actor: "second",
          action: "config.update",
          resource: "configuration",
          metadata: { hash: "sha256:one" },
          createdAt: new Date(now - 2_000),
        },
        {
          actor: "third",
          action: "review.trigger",
          resource: "review",
          metadata: { reviewId: "review-1" },
          createdAt: new Date(now - 1_000),
        },
      ],
    });

    const firstPage = await audit.listPage({ limit: 2, offset: 0 });
    expect(firstPage.total).toBe(3);
    expect(firstPage.rows.map((row) => row.actor)).toEqual(["third", "second"]);
    expect(firstPage.rows[1]?.metadata).toEqual({ hash: "sha256:one" });

    const secondPage = await audit.listPage({ limit: 2, offset: 2 });
    expect(secondPage.total).toBe(3);
    expect(secondPage.rows.map((row) => row.actor)).toEqual(["first"]);
  });
});
