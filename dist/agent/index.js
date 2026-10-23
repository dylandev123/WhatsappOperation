"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAgent = getAgent;
exports.startAgent = startAgent;
exports.stopAgent = stopAgent;
const config_js_1 = require("../config.js");
const whatsapp_js_1 = require("../whatsapp.js");
const bridge_js_1 = require("./bridge.js");
const inboxClient_js_1 = require("./inboxClient.js");
const journal_js_1 = require("./journal.js");
const types_js_1 = require("./types.js");
// Runtime wiring for the Inbox AI agent bridge: Inbox HTTP client, local
// journal and the guarded WhatsApp sender. Nothing here runs unless
// AGENT_ENABLED=true; nothing is sent unless AGENT_SEND_ENABLED=true too.
let bridge = null;
function getAgent() {
    return bridge;
}
function startAgent() {
    if (!config_js_1.config.agentEnabled)
        return null;
    if (!config_js_1.config.aiAgentUrl || !config_js_1.config.aiAgentBridgeSecret) {
        console.error("[agent] AGENT_ENABLED=true but AI_AGENT_URL/AI_AGENT_BRIDGE_SECRET are missing; agent not started");
        return null;
    }
    bridge = new bridge_js_1.AgentBridge({
        inbox: (0, inboxClient_js_1.createInboxClient)({ baseUrl: config_js_1.config.aiAgentUrl, secret: config_js_1.config.aiAgentBridgeSecret }),
        journal: (0, journal_js_1.createFileJournal)(config_js_1.config.agentStateFile, (message) => console.log(`[agent] ${message}`)),
        sender: {
            isConnected: whatsapp_js_1.isSessionConnected,
            async send(businessSlug, jid, body) {
                try {
                    return await (0, whatsapp_js_1.sendAgentText)(businessSlug, jid, body);
                }
                catch (error) {
                    if (error instanceof whatsapp_js_1.PreSendError)
                        throw new types_js_1.NotSentError(error.message);
                    throw error;
                }
            }
        },
        config: {
            enabled: config_js_1.config.agentEnabled,
            sendEnabled: config_js_1.config.agentSendEnabled,
            batchWindowMs: config_js_1.config.agentBatchWindowMs,
            tickMs: config_js_1.config.agentTickMs,
            configTtlMs: config_js_1.config.agentConfigTtlMs,
            maxMessageAgeMs: config_js_1.config.agentMaxMessageAgeMs,
            maxChatRepliesPerHour: config_js_1.config.agentMaxChatRepliesPerHour,
            maxBusinessSendsPerMinute: config_js_1.config.agentMaxBusinessSendsPerMinute,
            minSendGapMs: config_js_1.config.agentMinSendGapMs,
            maxForwardAttempts: config_js_1.config.agentMaxForwardAttempts,
            unknownSendHoldMs: config_js_1.config.agentUnknownSendHoldMs
        }
    });
    const running = bridge;
    // Hooks fire only for live 'notify' messages and inbox /api/send sends —
    // never for history imports (importHistory() doesn't call them).
    (0, whatsapp_js_1.setMessageHooks)({
        async onLiveMessage(businessSlug, msg, origin) {
            return running.onLiveMessage(businessSlug, msg, origin);
        }
    });
    running.start();
    return running;
}
async function stopAgent() {
    (0, whatsapp_js_1.setMessageHooks)(null);
    await bridge?.stop();
}
