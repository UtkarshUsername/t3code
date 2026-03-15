import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationReadModel,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);

async function seedProjectReadModel(now: string): Promise<OrchestrationReadModel> {
  return Effect.runPromise(
    projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: asEventId("evt-project-create"),
      aggregateKind: "project",
      aggregateId: asProjectId("project-1"),
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.makeUnsafe("cmd-project-create"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-project-create"),
      metadata: {},
      payload: {
        projectId: asProjectId("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModel: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

async function appendThreadToReadModel(
  readModel: OrchestrationReadModel,
  input: {
    now: string;
    sequence: number;
    eventId: string;
    commandId: string;
    threadId: string;
    title: string;
    interactionMode: "default" | "plan";
    runtimeMode: "approval-required" | "full-access";
  },
): Promise<OrchestrationReadModel> {
  return Effect.runPromise(
    projectEvent(readModel, {
      sequence: input.sequence,
      eventId: asEventId(input.eventId),
      aggregateKind: "thread",
      aggregateId: ThreadId.makeUnsafe(input.threadId),
      type: "thread.created",
      occurredAt: input.now,
      commandId: CommandId.makeUnsafe(input.commandId),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe(input.commandId),
      metadata: {},
      payload: {
        threadId: ThreadId.makeUnsafe(input.threadId),
        projectId: asProjectId("project-1"),
        title: input.title,
        model: "gpt-5-codex",
        interactionMode: input.interactionMode,
        runtimeMode: input.runtimeMode,
        branch: null,
        worktreePath: null,
        createdAt: input.now,
        updatedAt: input.now,
      },
    }),
  );
}

async function appendProposedPlanToReadModel(
  readModel: OrchestrationReadModel,
  input: {
    now: string;
    sequence: number;
    eventId: string;
    commandId: string;
    threadId: string;
    planId: string;
    turnId: string;
    planMarkdown: string;
  },
): Promise<OrchestrationReadModel> {
  return Effect.runPromise(
    projectEvent(readModel, {
      sequence: input.sequence,
      eventId: asEventId(input.eventId),
      aggregateKind: "thread",
      aggregateId: ThreadId.makeUnsafe(input.threadId),
      type: "thread.proposed-plan-upserted",
      occurredAt: input.now,
      commandId: CommandId.makeUnsafe(input.commandId),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe(input.commandId),
      metadata: {},
      payload: {
        threadId: ThreadId.makeUnsafe(input.threadId),
        proposedPlan: {
          id: input.planId,
          turnId: TurnId.makeUnsafe(input.turnId),
          planMarkdown: input.planMarkdown,
          implementedAt: null,
          implementationThreadId: null,
          createdAt: input.now,
          updatedAt: input.now,
        },
      },
    }),
  );
}

describe("decider project scripts", () => {
  it("emits empty scripts on project.create", async () => {
    const now = new Date().toISOString();
    const readModel = createEmptyReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-create-scripts"),
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.created");
    expect((event.payload as { scripts: unknown[] }).scripts).toEqual([]);
  });

  it("propagates scripts in project.meta.update payload", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const readModel = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-scripts"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-scripts"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create-scripts"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create-scripts"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          defaultModel: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const scripts = [
      {
        id: "lint",
        name: "Lint",
        command: "bun run lint",
        icon: "lint",
        runOnWorktreeCreate: false,
      },
    ] as const;

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-project-update-scripts"),
          projectId: asProjectId("project-scripts"),
          scripts: Array.from(scripts),
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.meta-updated");
    expect((event.payload as { scripts?: unknown[] }).scripts).toEqual(scripts);
  });

  it("emits user message and turn-start-requested events for thread.turn.start", async () => {
    const now = new Date().toISOString();
    const readModel = await appendThreadToReadModel(await seedProjectReadModel(now), {
      now,
      sequence: 2,
      eventId: "evt-thread-create",
      commandId: "cmd-thread-create",
      threadId: "thread-1",
      title: "Thread",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
    });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId("message-user-1"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          provider: "codex",
          model: "gpt-5.3-codex",
          modelOptions: {
            codex: {
              reasoningEffort: "high",
              fastMode: true,
            },
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    const events = Array.isArray(result) ? result : [result];
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("thread.message-sent");
    const turnStartEvent = events[1];
    expect(turnStartEvent?.type).toBe("thread.turn-start-requested");
    expect(turnStartEvent?.causationEventId).toBe(events[0]?.eventId ?? null);
    if (turnStartEvent?.type !== "thread.turn-start-requested") {
      return;
    }
    expect(turnStartEvent.payload.assistantDeliveryMode).toBe("buffered");
    expect(turnStartEvent.payload).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      messageId: asMessageId("message-user-1"),
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: {
        codex: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      runtimeMode: "approval-required",
    });
  });

  it("carries the source proposed plan reference in turn-start-requested", async () => {
    const now = new Date().toISOString();
    const withSourceThread = await appendThreadToReadModel(await seedProjectReadModel(now), {
      now,
      sequence: 2,
      eventId: "evt-thread-create-source",
      commandId: "cmd-thread-create-source",
      threadId: "thread-plan",
      title: "Plan Thread",
      interactionMode: "plan",
      runtimeMode: "approval-required",
    });
    const withTargetThread = await appendThreadToReadModel(withSourceThread, {
      now,
      sequence: 3,
      eventId: "evt-thread-create-target",
      commandId: "cmd-thread-create-target",
      threadId: "thread-implement",
      title: "Implementation Thread",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
    });
    const readModel = await appendProposedPlanToReadModel(withTargetThread, {
      now,
      sequence: 4,
      eventId: "evt-plan-upsert",
      commandId: "cmd-plan-upsert",
      threadId: "thread-plan",
      planId: "plan-1",
      turnId: "turn-1",
      planMarkdown: "# Plan",
    });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start-source-plan"),
          threadId: ThreadId.makeUnsafe("thread-implement"),
          message: {
            messageId: asMessageId("message-user-2"),
            role: "user",
            text: "PLEASE IMPLEMENT THIS PLAN:\n# Plan",
            attachments: [],
          },
          sourceProposedPlan: {
            threadId: ThreadId.makeUnsafe("thread-plan"),
            planId: "plan-1",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    const events = Array.isArray(result) ? result : [result];
    expect(events).toHaveLength(2);
    expect(events[1]?.type).toBe("thread.turn-start-requested");
    if (events[1]?.type !== "thread.turn-start-requested") {
      return;
    }
    expect(events[1].payload.sourceProposedPlan).toMatchObject({
      threadId: "thread-plan",
      planId: "plan-1",
    });
  });

  it("rejects thread.turn.start when the source proposed plan is missing", async () => {
    const now = new Date().toISOString();
    const withSourceThread = await appendThreadToReadModel(await seedProjectReadModel(now), {
      now,
      sequence: 2,
      eventId: "evt-thread-create-source",
      commandId: "cmd-thread-create-source",
      threadId: "thread-plan",
      title: "Plan Thread",
      interactionMode: "plan",
      runtimeMode: "approval-required",
    });
    const readModel = await appendThreadToReadModel(withSourceThread, {
      now,
      sequence: 3,
      eventId: "evt-thread-create-target",
      commandId: "cmd-thread-create-target",
      threadId: "thread-implement",
      title: "Implementation Thread",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
    });

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("cmd-turn-start-missing-source-plan"),
            threadId: ThreadId.makeUnsafe("thread-implement"),
            message: {
              messageId: asMessageId("message-user-3"),
              role: "user",
              text: "PLEASE IMPLEMENT THIS PLAN:\n# Missing",
              attachments: [],
            },
            sourceProposedPlan: {
              threadId: ThreadId.makeUnsafe("thread-plan"),
              planId: "plan-missing",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("Proposed plan 'plan-missing' does not exist on thread 'thread-plan'.");
  });

  it("emits thread.runtime-mode-set from thread.runtime-mode.set", async () => {
    const now = new Date().toISOString();
    const readModel = await appendThreadToReadModel(await seedProjectReadModel(now), {
      now,
      sequence: 2,
      eventId: "evt-thread-create",
      commandId: "cmd-thread-create",
      threadId: "thread-1",
      title: "Thread",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
    });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.runtime-mode.set",
          commandId: CommandId.makeUnsafe("cmd-runtime-mode-set"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    const singleResult = Array.isArray(result) ? null : result;
    if (singleResult === null) {
      throw new Error("Expected a single runtime-mode-set event.");
    }
    expect(singleResult).toMatchObject({
      type: "thread.runtime-mode-set",
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
      },
    });
  });

  it("emits thread.interaction-mode-set from thread.interaction-mode.set", async () => {
    const now = new Date().toISOString();
    const readModel = await appendThreadToReadModel(await seedProjectReadModel(now), {
      now,
      sequence: 2,
      eventId: "evt-thread-create",
      commandId: "cmd-thread-create",
      threadId: "thread-1",
      title: "Thread",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
    });

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.interaction-mode.set",
          commandId: CommandId.makeUnsafe("cmd-interaction-mode-set"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          interactionMode: "plan",
          createdAt: now,
        },
        readModel,
      }),
    );

    const singleResult = Array.isArray(result) ? null : result;
    if (singleResult === null) {
      throw new Error("Expected a single interaction-mode-set event.");
    }
    expect(singleResult).toMatchObject({
      type: "thread.interaction-mode-set",
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionMode: "plan",
      },
    });
  });
});
