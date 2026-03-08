import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import { getAcpSessionManager } from "../../acp/control-plane/manager.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  isResolvedSessionVisibleToRequester,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSandboxedSessionToolContext,
} from "./sessions-helpers.js";

const SessionsCloseToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
});

export function createSessionsCloseTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Session Close",
    name: "sessions_close",
    description:
      "Close an ACP harness session and release its runtime/thread binding. Use sessionKey or label.",
    parameters: SessionsCloseToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = loadConfig();
      const { mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSandboxedSessionToolContext({
          cfg,
          agentSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed,
        });

      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const sessionVisibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });

      const sessionKeyParam = readStringParam(params, "sessionKey");
      const labelParam = readStringParam(params, "label")?.trim() || undefined;
      const labelAgentIdParam = readStringParam(params, "agentId")?.trim() || undefined;
      if (sessionKeyParam && labelParam) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Provide either sessionKey or label (not both).",
        });
      }

      let sessionKey = sessionKeyParam;
      if (!sessionKey && labelParam) {
        const requesterAgentId = resolveAgentIdFromSessionKey(effectiveRequesterKey);
        const requestedAgentId = labelAgentIdParam
          ? normalizeAgentId(labelAgentIdParam)
          : undefined;

        if (restrictToSpawned && requestedAgentId && requestedAgentId !== requesterAgentId) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error: "Sandboxed sessions_close label lookup is limited to this agent",
          });
        }

        if (requesterAgentId && requestedAgentId && requestedAgentId !== requesterAgentId) {
          if (!a2aPolicy.enabled) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error:
                "Agent-to-agent session close is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent closes.",
            });
          }
          if (!a2aPolicy.isAllowed(requesterAgentId, requestedAgentId)) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Agent-to-agent session close denied by tools.agentToAgent.allow.",
            });
          }
        }

        const resolveParams: Record<string, unknown> = {
          label: labelParam,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
          ...(restrictToSpawned ? { spawnedBy: effectiveRequesterKey } : {}),
        };
        let resolvedKey = "";
        try {
          const resolved = await callGateway<{ key: string }>({
            method: "sessions.resolve",
            params: resolveParams,
            timeoutMs: 10_000,
          });
          resolvedKey = typeof resolved?.key === "string" ? resolved.key.trim() : "";
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: msg || `No session found with label: ${labelParam}`,
          });
        }

        if (!resolvedKey) {
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: `No session found with label: ${labelParam}`,
          });
        }
        sessionKey = resolvedKey;
      }

      if (!sessionKey) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Either sessionKey or label is required",
        });
      }

      const resolvedSession = await resolveSessionReference({
        sessionKey,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: resolvedSession.status,
          error: resolvedSession.error,
        });
      }

      const resolvedKey = resolvedSession.key;
      const displayKey = resolvedSession.displayKey;
      const resolvedViaSessionId = resolvedSession.resolvedViaSessionId;

      const visible = await isResolvedSessionVisibleToRequester({
        requesterSessionKey: effectiveRequesterKey,
        targetSessionKey: resolvedKey,
        restrictToSpawned,
        resolvedViaSessionId,
      });
      if (!visible) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "forbidden",
          error: `Session not visible from this sandboxed agent session: ${sessionKey}`,
          sessionKey: displayKey,
        });
      }

      const visibilityGuard = await createSessionVisibilityGuard({
        action: "close",
        requesterSessionKey: effectiveRequesterKey,
        visibility: sessionVisibility,
        a2aPolicy,
      });
      const access = visibilityGuard.check(resolvedKey);
      if (!access.allowed) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: access.status,
          error: access.error,
          sessionKey: displayKey,
        });
      }

      const acpManager = getAcpSessionManager();
      const resolution = acpManager.resolveSession({
        cfg,
        sessionKey: resolvedKey,
      });
      if (resolution.kind === "none") {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: `Session is not ACP-enabled: ${displayKey}`,
          sessionKey: displayKey,
        });
      }
      if (resolution.kind === "stale") {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: resolution.error.message,
          sessionKey: displayKey,
        });
      }

      try {
        const closed = await acpManager.closeSession({
          cfg,
          sessionKey: resolvedKey,
          reason: "agent-tool-close",
          allowBackendUnavailable: true,
          clearMeta: true,
        });
        const removedBindings = await getSessionBindingService().unbind({
          targetSessionKey: resolvedKey,
          reason: "manual",
        });
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "closed",
          sessionKey: displayKey,
          runtimeClosed: closed.runtimeClosed,
          metaCleared: closed.metaCleared,
          runtimeNotice: closed.runtimeNotice,
          removedBindings: removedBindings.length,
        });
      } catch (error) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          sessionKey: displayKey,
        });
      }
    },
  };
}
