import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { PluginWorkerMessage } from "./PluginWorkerProtocol.ts";

const decode = Schema.decodeUnknownSync(PluginWorkerMessage);

describe("PluginWorkerProtocol", () => {
  it("decodes activation and host capability messages", () => {
    expect(
      decode({
        type: "activated",
        commands: [
          {
            id: "acme.issue.create",
            label: "Create issue",
            surfaces: ["web"],
          },
        ],
        ui: {
          settings: [],
          navigation: [],
          views: [],
          cards: [],
          statusItems: [],
          composerActions: [],
          contextualActions: [],
        },
      }),
    ).toMatchObject({ type: "activated", commands: [{ id: "acme.issue.create" }] });

    expect(
      decode({
        type: "hostCall",
        callId: "call-1",
        operation: "state.set",
        key: "cursor",
        value: { page: 2 },
      }),
    ).toEqual({
      type: "hostCall",
      callId: "call-1",
      operation: "state.set",
      key: "cursor",
      value: { page: 2 },
    });

    expect(
      decode({
        type: "hostCall",
        callId: "call-2",
        operation: "ui.notify",
        notification: {
          id: "challenge-complete",
          title: "Challenge complete",
          message: "Nice work.",
          tone: "success",
        },
      }),
    ).toMatchObject({ operation: "ui.notify", notification: { tone: "success" } });
  });

  it("rejects malformed messages, executable metadata, and excess properties", () => {
    for (const message of [
      { type: "activated", commands: [{ id: "", label: "bad", surfaces: ["web"] }], ui: {} },
      { type: "hostCall", callId: "call-1", operation: "state.set", key: "cursor" },
      {
        type: "hostCall",
        callId: "call-1",
        operation: "process.run",
        command: "sh",
        args: [],
        extra: true,
      },
      { type: "invocationResult", requestId: "../bad", value: null },
      { type: "unknown" },
    ]) {
      expect(() => decode(message)).toThrow();
    }
  });
});
