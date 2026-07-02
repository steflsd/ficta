import type { UIMessage } from "@tanstack/ai-react";
import { describe, expect, it } from "vitest";
import { storedToUi, uiToStored } from "@/lib/storage/messages";

// The mappers are the glue between the live chat client (UIMessage, createdAt: Date) and the persisted
// form (StoredMessage, createdAt: ISO string). This covers the client-side conversion that the streaming
// save/hydrate path relies on but which can't be exercised without a live model call.
describe("message mapping", () => {
  it("round-trips a UIMessage through storage form", () => {
    const created = new Date("2026-07-02T08:00:00.000Z");
    const ui: UIMessage = {
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
      createdAt: created,
    };

    const stored = uiToStored(ui);
    expect(stored).toEqual({
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
      createdAt: "2026-07-02T08:00:00.000Z",
    });

    const back = storedToUi(stored);
    expect(back.id).toBe("m1");
    expect(back.role).toBe("assistant");
    expect(back.parts).toEqual(ui.parts);
    expect(back.createdAt?.toISOString()).toBe(created.toISOString());
  });

  it("tolerates a message without a timestamp", () => {
    const stored = uiToStored({ id: "x", role: "user", parts: [] });
    expect(stored.createdAt).toBeUndefined();
    expect(storedToUi(stored).createdAt).toBeUndefined();
  });
});
