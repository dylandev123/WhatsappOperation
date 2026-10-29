import { config } from "../config.js";
import { isSessionConnected, PreSendError, sendAgentText, setMessageHooks } from "../whatsapp.js";
import { AgentBridge } from "./bridge.js";
import { CallTracker } from "./calls.js";
import { createInboxClient } from "./inboxClient.js";
import { createFileJournal } from "./journal.js";
import { NotSentError } from "./types.js";

// Runtime wiring for the Inbox AI agent bridge: Inbox HTTP client, local
// journal and the guarded WhatsApp sender. Nothing here runs unless
// AGENT_ENABLED=true; nothing is sent unless AGENT_SEND_ENABLED=true too.

let bridge: AgentBridge | null = null;

export function getAgent(): AgentBridge | null {
  return bridge;
}

export function startAgent(): AgentBridge | null {
  if (!config.agentEnabled) return null;
  if (!config.aiAgentUrl || !config.aiAgentBridgeSecret) {
    console.error("[agent] AGENT_ENABLED=true but AI_AGENT_URL/AI_AGENT_BRIDGE_SECRET are missing; agent not started");
    return null;
  }

  bridge = new AgentBridge({
    inbox: createInboxClient({ baseUrl: config.aiAgentUrl, secret: config.aiAgentBridgeSecret }),
    journal: createFileJournal(config.agentStateFile, (message) => console.log(`[agent] ${message}`)),
    sender: {
      isConnected: isSessionConnected,
      async send(businessSlug, jid, body, quotedMessageId) {
        try {
          return await sendAgentText(businessSlug, jid, body, quotedMessageId);
        } catch (error) {
          if (error instanceof PreSendError) throw new NotSentError(error.message);
          throw error;
        }
      }
    },
    config: {
      enabled: config.agentEnabled,
      sendEnabled: config.agentSendEnabled,
      batchWindowMs: config.agentBatchWindowMs,
      tickMs: config.agentTickMs,
      configTtlMs: config.agentConfigTtlMs,
      maxMessageAgeMs: config.agentMaxMessageAgeMs,
      maxChatRepliesPerHour: config.agentMaxChatRepliesPerHour,
      maxBusinessSendsPerMinute: config.agentMaxBusinessSendsPerMinute,
      minSendGapMs: config.agentMinSendGapMs,
      maxForwardAttempts: config.agentMaxForwardAttempts,
      unknownSendHoldMs: config.agentUnknownSendHoldMs
    }
  });

  const running = bridge;
  const calls = new CallTracker();
  // Hooks fire only for live 'notify' messages and inbox /api/send sends —
  // never for history imports (importHistory() doesn't call them).
  setMessageHooks({
    async onLiveMessage(businessSlug, msg, origin) {
      return running.onLiveMessage(businessSlug, msg, origin);
    },
    onCallEvents(businessSlug, events, selfIds) {
      for (const event of events) {
        const report = calls.handle(businessSlug, event, selfIds);
        if (!report) continue;
        const { businessSlug: _slug, ...rest } = report;
        void running.onCallReport(businessSlug, rest).then(
          (outcome) => console.log(`[${businessSlug}] [agent] call ${report.callId} ${report.finalStatus}: ${outcome}`),
          (err) => console.error(`[${businessSlug}] agent call hook failed:`, err instanceof Error ? err.message : err)
        );
      }
    }
  });

  running.start();
  return running;
}

export async function stopAgent() {
  setMessageHooks(null);
  await bridge?.stop();
}
