import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const resolveSessionMock = vi.fn();
  const closeSessionMock = vi.fn();
  const unbindMock = vi.fn();
  const state = {
    cfg: {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: false },
      },
      agents: {
        defaults: {
          sandbox: {
            sessionToolsVisibility: "spawned",
          },
        },
      },
    } as OpenClawConfig,
  };
  return {
    callGatewayMock,
    closeSessionMock,
    resolveSessionMock,
    state,
    unbindMock,
  };
});

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => hoisted.state.cfg,
  };
});

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: (params: unknown) => hoisted.resolveSessionMock(params),
    closeSession: (params: unknown) => hoisted.closeSessionMock(params),
  }),
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    unbind: (input: unknown) => hoisted.unbindMock(input),
  }),
}));

const { createSessionsCloseTool } = await import("./sessions-close-tool.js");

describe("sessions_close tool", () => {
  beforeEach(() => {
    hoisted.state.cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: false },
      },
      agents: {
        defaults: {
          sandbox: {
            sessionToolsVisibility: "spawned",
          },
        },
      },
    } as OpenClawConfig;

    hoisted.callGatewayMock.mockReset().mockResolvedValue({});
    hoisted.resolveSessionMock.mockReset().mockReturnValue({
      kind: "ready",
      sessionKey: "agent:codex:acp:session-1",
      meta: {},
    });
    hoisted.closeSessionMock.mockReset().mockResolvedValue({
      runtimeClosed: true,
      metaCleared: true,
    });
    hoisted.unbindMock.mockReset().mockResolvedValue([{ bindingId: "binding-1" }]);
  });

  it("closes an ACP session by sessionKey", async () => {
    const tool = createSessionsCloseTool({
      agentSessionKey: "agent:codex:main",
    });

    const result = await tool.execute("call-1", {
      sessionKey: "agent:codex:acp:session-1",
    });

    expect(result.details).toMatchObject({
      status: "closed",
      sessionKey: "agent:codex:acp:session-1",
      runtimeClosed: true,
      metaCleared: true,
      removedBindings: 1,
    });
    expect(hoisted.closeSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:codex:acp:session-1",
        reason: "agent-tool-close",
        clearMeta: true,
        allowBackendUnavailable: true,
      }),
    );
    expect(hoisted.unbindMock).toHaveBeenCalledWith({
      targetSessionKey: "agent:codex:acp:session-1",
      reason: "manual",
    });
  });

  it("resolves labels before closing", async () => {
    hoisted.callGatewayMock.mockImplementation(async (requestUnknown: unknown) => {
      const request = requestUnknown as { method?: string };
      if (request.method === "sessions.resolve") {
        return { key: "agent:codex:acp:session-2" };
      }
      return {};
    });
    const tool = createSessionsCloseTool({
      agentSessionKey: "agent:codex:main",
    });

    const result = await tool.execute("call-2", {
      label: "review-thread",
    });

    expect(result.details).toMatchObject({
      status: "closed",
      sessionKey: "agent:codex:acp:session-2",
    });
    expect(hoisted.callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.resolve",
        params: expect.objectContaining({
          label: "review-thread",
        }),
      }),
    );
  });

  it("rejects non-ACP sessions", async () => {
    hoisted.resolveSessionMock.mockReturnValue({
      kind: "none",
      sessionKey: "agent:codex:main",
    });
    const tool = createSessionsCloseTool({
      agentSessionKey: "agent:codex:main",
    });

    const result = await tool.execute("call-3", {
      sessionKey: "agent:codex:main",
    });

    expect(result.details).toMatchObject({
      status: "error",
      error: "Session is not ACP-enabled: agent:codex:main",
    });
    expect(hoisted.closeSessionMock).not.toHaveBeenCalled();
    expect(hoisted.unbindMock).not.toHaveBeenCalled();
  });

  it("blocks cross-agent closes when session visibility is restricted", async () => {
    hoisted.state.cfg = {
      ...hoisted.state.cfg,
      tools: {
        sessions: { visibility: "tree" },
        agentToAgent: { enabled: false },
      },
    } as OpenClawConfig;
    hoisted.callGatewayMock.mockImplementation(async (requestUnknown: unknown) => {
      const request = requestUnknown as { method?: string };
      if (request.method === "sessions.list") {
        return { sessions: [] };
      }
      return {};
    });
    const tool = createSessionsCloseTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-4", {
      sessionKey: "agent:other:acp:session-9",
    });

    expect(result.details).toMatchObject({
      status: "forbidden",
    });
    expect((result.details as { error?: string }).error).toContain(
      "Session close visibility is restricted",
    );
    expect(hoisted.closeSessionMock).not.toHaveBeenCalled();
  });
});
