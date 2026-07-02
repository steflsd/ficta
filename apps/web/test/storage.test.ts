// Drive the storage seam against an in-memory PGlite through the REAL getStorage()/getDb() path, which
// also exercises the migration applier (migrate.server.ts) on boot. `memory://` makes PGlite ephemeral;
// setting it before any import that touches the DB is what routes create() to an in-memory instance.
process.env.FICTA_WEB_DATA_DIR = "memory://";
process.env.DATABASE_URL = "";

import { beforeAll, describe, expect, it } from "vitest";
import type { Storage } from "@/lib/storage/storage.server";
import { getStorage } from "@/lib/storage/storage.server";
import type { StoredMessage } from "@/lib/storage/types";

let store: Storage;

beforeAll(async () => {
  store = await getStorage();
});

const textMessage = (id: string, role: StoredMessage["role"], text: string): StoredMessage => ({
  id,
  role,
  parts: [{ type: "text", text }],
});

describe("user settings", () => {
  it("returns {} for an unknown user and merges patches", async () => {
    expect(await store.getUserSettings("u-new")).toEqual({});

    const first = await store.patchUserSettings("u-1", { defaultModel: { provider: "openai", model: "gpt-5" } });
    expect(first.defaultModel).toEqual({ provider: "openai", model: "gpt-5" });

    // A patch merges over the stored object rather than replacing it.
    const second = await store.patchUserSettings("u-1", {});
    expect(second.defaultModel).toEqual({ provider: "openai", model: "gpt-5" });
    expect(await store.getUserSettings("u-1")).toEqual(second);
  });

  it("scopes settings per user", async () => {
    await store.patchUserSettings("u-a", { defaultModel: { provider: "anthropic", model: "claude-sonnet-4-6" } });
    expect(await store.getUserSettings("u-b")).toEqual({});
  });
});

const ORG = "local";

describe("instance settings", () => {
  it("is one row per workspace that merges patches", async () => {
    expect(await store.getInstanceSettings(ORG)).toEqual({});
    await store.patchInstanceSettings(ORG, { instanceName: "Acme" });
    await store.patchInstanceSettings(ORG, { allowedModels: ["openai/gpt-5"] });
    expect(await store.getInstanceSettings(ORG)).toEqual({ instanceName: "Acme", allowedModels: ["openai/gpt-5"] });
  });

  it("isolates settings per workspace (org)", async () => {
    await store.patchInstanceSettings("org-x", { instanceName: "X" });
    await store.patchInstanceSettings("org-y", { instanceName: "Y" });
    expect((await store.getInstanceSettings("org-x")).instanceName).toBe("X");
    expect((await store.getInstanceSettings("org-y")).instanceName).toBe("Y");
  });
});

describe("threads + messages", () => {
  it("creates a thread from a snapshot, deriving the title from the first user message", async () => {
    const messages = [
      textMessage("m1", "user", "How do I redact secrets?"),
      textMessage("m2", "assistant", "Like so."),
    ];
    await store.saveThreadSnapshot("owner", ORG, "t1", messages);

    const loaded = await store.getThread("owner", ORG, "t1");
    expect(loaded?.thread.title).toBe("How do I redact secrets?");
    expect(loaded?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(loaded?.messages[0]?.parts).toEqual([{ type: "text", text: "How do I redact secrets?" }]);
  });

  it("snapshot-upsert drops messages no longer present (regenerate) and preserves order", async () => {
    await store.saveThreadSnapshot("owner", ORG, "t2", [
      textMessage("a", "user", "hi"),
      textMessage("b", "assistant", "first answer"),
    ]);
    // Regenerate: the trailing assistant message is replaced with a new id.
    await store.saveThreadSnapshot("owner", ORG, "t2", [
      textMessage("a", "user", "hi"),
      textMessage("c", "assistant", "second answer"),
    ]);

    const loaded = await store.getThread("owner", ORG, "t2");
    expect(loaded?.messages.map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("lists threads for a user, most-recently-updated first", async () => {
    await store.saveThreadSnapshot("lister", ORG, "old", [textMessage("x", "user", "old")]);
    await store.saveThreadSnapshot("lister", ORG, "new", [textMessage("y", "user", "new")]);
    const list = await store.listThreads("lister", ORG);
    expect(list[0]?.id).toBe("new");
    expect(list.map((t) => t.id)).toContain("old");
  });

  it("isolates threads by user", async () => {
    await store.saveThreadSnapshot("alice", ORG, "secret", [textMessage("s", "user", "mine")]);
    expect(await store.getThread("mallory", ORG, "secret")).toBeNull();
    await expect(
      store.saveThreadSnapshot("mallory", ORG, "secret", [textMessage("s2", "user", "hijack")]),
    ).rejects.toThrow();
  });

  it("isolates a user's threads across workspaces", async () => {
    // Same user, two workspaces: a thread created in one is invisible from the other, and listThreads is
    // partitioned by org.
    await store.saveThreadSnapshot("multi", "org-a", "ta", [textMessage("pa", "user", "in A")]);
    await store.saveThreadSnapshot("multi", "org-b", "tb", [textMessage("pb", "user", "in B")]);

    expect(await store.getThread("multi", "org-b", "ta")).toBeNull();
    expect((await store.listThreads("multi", "org-a")).map((t) => t.id)).toEqual(["ta"]);
    expect((await store.listThreads("multi", "org-b")).map((t) => t.id)).toEqual(["tb"]);

    // A snapshot for the same thread id but the wrong workspace must not hijack it.
    await expect(
      store.saveThreadSnapshot("multi", "org-b", "ta", [textMessage("x", "user", "hijack")]),
    ).rejects.toThrow();
  });

  it("renames and deletes", async () => {
    await store.saveThreadSnapshot("owner", ORG, "t3", [textMessage("z", "user", "original")]);
    await store.renameThread("owner", ORG, "t3", "Renamed");
    expect((await store.getThread("owner", ORG, "t3"))?.thread.title).toBe("Renamed");

    await store.deleteThread("owner", ORG, "t3");
    expect(await store.getThread("owner", ORG, "t3")).toBeNull();
  });
});
