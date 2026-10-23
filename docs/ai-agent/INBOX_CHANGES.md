# Suggested changes to the inbox (devaux-whatsapp-inbox)

These came up while fitting the bridge to the inbox contract. **None of them is required to go
live.** The bridge works with the inbox exactly as it is, and no inbox schema change or migration
is needed. Every item below is a gap that currently fails in the safe direction or relies on bridge
logs. They are listed separately, so they can be scheduled on their own. Nothing here has been
applied.

## 1. Unknown sends are invisible in the admin UI (done in the inbox, no schema change)

`/admin/ai-agent` → Activity now lists `ai_agent_outbox`: recipient, kind, timestamps, error and
WhatsApp id. Any item still `dispatched` 10 minutes after hand-off is flagged **unresolved**.
A `failed` ack whose `error` is one of the bridge's policy codes (`observe_mode`,
`bridge_send_disabled`, `human_takeover`, the rate limits and so on) is shown as **blocked**.
Every other code is shown as a real failure. This is read-only and needs no bridge change. The
code list lives in the inbox (`lib/aiAgent/outboxStatus.ts`, contract §3.3). If `blockReason()` in
`src/agent/bridge.ts` gains a new code, add it there too, or admins will see it as a failure.

## 2. No way to report "unknown" on /ack (optional, needs a migration)

`/ack` accepts only `sent` and `failed`, and `ai_agent_outbox.status` is checked to
`pending | dispatched | sent | failed`. The bridge cannot report what it knows, so it can't tell
the inbox to take over the chat after an ambiguous send. Today it holds the chat locally instead.

Still not needed: the admin view's "unresolved" flag covers visibility. If wanted later: allow `status: "unknown"` on `/ack`, add `'unknown'` to the check constraint, count
`unknown` with `dispatched`/`sent` in `autoRepliesLastHour()`, and set the conversation to
`control = 'human'` when a customer-facing item comes back unknown. The bridge would need a small
follow-up change to send it; it does not send it now.

## 3. Scheduled sends count as manual staff activity (low priority, safe direction)

`latestManualStaffMessageAt()` (`lib/server/aiAgent/context.ts`) treats any outbound
`whatsapp_messages` row that isn't an agent send as a human. The scheduler's sends are saved
there too. So a scheduled broadcast pauses the AI in each recipient chat for
`auto_takeover_minutes`. That only ever suppresses AI replies. If unwanted, exclude rows whose
`whatsapp_message_id` appears in `scheduled_message_deliveries`.

## 4. Body-based echo matching can swallow a real human message (low priority)

`isAgentEcho()` (`lib/server/aiAgent/outbox.ts`) drops a `fromMe` or staff-group message whose
text equals any agent outbox body sent to that chat in the last 24 h. Acked rows already carry
their WhatsApp id. Restricting the body fallback to rows with no `whatsapp_message_id` yet would
stop it from hiding a genuine human message (for example staff typing the same "Thanks!"). Then
the takeover it should trigger would no longer be missed. The bridge never forwards its own sends,
so it doesn't need the body fallback at all.
