# Inbox AI agent — bridge side (WhatsappOperation)

The contract is owned by the inbox repo:
`devaux-whatsapp-inbox/docs/ai-agent-bridge-contract.md`. This file only describes how
`src/agent/` implements it, plus the transport safeguards it adds. All business state is in the
inbox's `ai_agent_*` tables. That covers eligibility, decisions, `#E-XXXXX` escalations, staff
commands, takeover, order requests, outbox and audit. The bridge owns no business state and
reads or writes none of those tables.

## Switches

| Env | Default | Effect |
|---|---|---|
| `AGENT_ENABLED` | `false` | Forward live messages to `/message`. Off = the agent code never runs. |
| `AGENT_SEND_ENABLED` | `false` | Send `send: true` items. Off = every returned item is acked `failed` (`bridge_send_disabled`), and `/outbox/claim` is never polled, so admin answers stay `pending`. |
| Inbox `mode` | `observe` | The inbox produces no customer-bound outbox in Observe. With `staffNoticesEnabled: true` in `/config` it may return `staff_notice` and `staff_draft` items for the staff group, and the bridge sends exactly those (never any other kind) provided `AGENT_SEND_ENABLED=true`. Everything else is refused (`observe_mode`; `staff_notices_disabled` when the flag is off). |

Nothing goes to WhatsApp unless all three allow it: `AGENT_ENABLED`, `AGENT_SEND_ENABLED`, and
the inbox enabled for that business in Assisted mode.

## What is forwarded

Only live `messages.upsert` (`notify`) messages and the inbox's own `/api/send` sends:

- inbound 1:1 messages (text or media; media-only goes with `hasMedia: true`, and the inbox escalates it)
- `fromMe` 1:1 messages a human sent (phone or `/api/send`), which trigger the inbox's takeover
- every message in the configured `staffGroupJid`, `fromMe` included. Each carries `senderJid` (the group participant, as WhatsApp reported it; null when WhatsApp gives none, e.g. `fromMe`) and, for `@lid` participants only, `senderPhone` from Baileys `participantPn` (null otherwise; never derived from the `@lid` digits). `quotedMessageId` is the exact quoted WhatsApp id.

Never forwarded:

- history imports: `importHistory()` never calls the hooks
- scheduled sends (origin `scheduled`)
- the bridge's own outbox sends (origin `agent`)
- other groups, status/broadcast/newsletter chats, protocol messages, reactions, edits
- customer messages older than `AGENT_MAX_MESSAGE_AGE_MS` (offline catch-up)

An echo of a bot or scheduled send can arrive before `sendMessage()` returns its id. Those
echoes are matched by chat and body (`pendingOwnSends` in `whatsapp.ts`), so they are never
mistaken for a phone message.

## Batching

The inbox decides one message at a time. The bridge holds a customer's burst until the chat has
been quiet for `AGENT_BATCH_WINDOW_MS`. It then forwards every message in order, so each one gets
an event and its own safeguards. A `customer_reply` to a message that is no longer the customer's
latest is not sent. It is acked `failed` with `superseded_by_newer_message`. The reply to the
latest message sees the earlier ones in its transcript. Holding replies and staff notices are
never superseded. A human or staff-group message flushes its chat straight away.

## Send checks (block only, never alter)

Run before every send, and again after the minimum-gap wait. A blocked item is acked `failed`
with the reason as `error`:

| Reason | Applies to |
|---|---|
| `bridge_send_disabled`, `observe_mode`, `staff_notices_disabled`, `bridge_config_unavailable`, `session_disconnected`, `invalid_body` | all |
| `not_staff_group` | group items whose `to` isn't the configured staff group |
| `human_takeover` | AI items whose triggering customer message came before a human message in the chat |
| `superseded_by_newer_message` | `customer_reply` |
| `stale_reply` | AI items whose trigger is older than `AGENT_MAX_MESSAGE_AGE_MS` |
| `held_after_unknown_send` | AI items to a chat on hold (see below) |
| `unapproved_commitment` | `customer_reply` that reads as confirming an order, payment or delivery (backstop to the inbox's own check) |
| `chat_rate_limited`, `business_rate_limited` | AI items over `AGENT_MAX_CHAT_REPLIES_PER_HOUR` or `AGENT_MAX_BUSINESS_SENDS_PER_MINUTE`; in Observe mode, staff notices are also capped at `AGENT_MAX_BUSINESS_SENDS_PER_MINUTE` |

"AI items" means every kind sent to a customer except `staff_relay`, including kinds the bridge
doesn't know yet. `staff_relay` is staff-authored, so it is not subject to takeover, supersede,
rate or hold checks. `AGENT_MIN_SEND_GAP_MS` spaces out all sends.

## Send outcomes and acks

| Outcome | Ack | Inbox outbox status |
|---|---|---|
| sent | `sent` + Baileys id (the inbox needs this to match quoted replies to `staff_notice` and `staff_draft`) | `sent` |
| provably not sent (`PreSendError`) or blocked | `failed` + reason | `failed` |
| ambiguous (timeout, socket error, crash mid-send) | **none** | stays `dispatched` |

Unknown outcomes are never acked as `sent` (that may be false) or as `failed`. A `failed` row
would stop counting toward the inbox's `max_auto_replies_per_hour`, and its body would no longer
be treated as possibly delivered. The bridge logs `outcome UNKNOWN` and lists the item in
`GET /api/agent/status`. It also puts the chat on hold for `AGENT_UNKNOWN_SEND_HOLD_MS`, which
blocks AI messages to it until the hold expires or an admin clears it with
`POST /api/agent/holds/clear {businessSlug, chatId}` after checking the chat. Acks that fail in
transit are retried. Sends are never retried.

## Restart safety: the local journal

`AGENT_STATE_FILE` (default `./auth/agent-bridge-state.json`, on the existing `./auth` volume)
is written with an fsync and an atomic rename after every change. It holds transport bookkeeping
only:

- forwards not yet accepted, which survive restarts and outages (the inbox dedupes on `(businessSlug, whatsappMessageId)`)
- every outbox id seen, so no id is ever sent twice
- a `sending` mark written before the socket call: on restart it becomes `unknown`, is not resent and is not acked
- items recorded but not yet attempted, which are sent after a restart (they never left the bridge)
- pending acks, human/customer activity times for the checks above, and holds

If the journal is lost, nothing is resent. Re-forwarded messages come back `duplicate` with
`send: false`. Run a single bridge instance; the Baileys sessions already require that.

## Endpoints (x-admin-secret)

- `GET /api/agent/status`: switches, inbox config as seen, queue sizes, unknown sends, holds
- `POST /api/agent/holds/clear`: clears a hold. Takeover and resume belong to the inbox (`/admin/ai-agent`, `!takeover` / `!resume`).

## Staff drafts and quoting

`staff_draft` is a staff-group kind like `staff_notice`: allowed in Observe only with `staffNoticesEnabled`,
blocked by `AGENT_SEND_ENABLED=false`, and refused (`not_staff_group`) if addressed to anything but the
configured staff group, in every mode (also `staff_notice` / `staff_feedback`). `replyToMessageId` is
posted as a WhatsApp quote of that message when the bridge has seen it in the group recently (in-memory,
last 500 group messages); otherwise the draft is sent unquoted. A quote can never block a send.

`/outbox/claim` is also polled for Observe businesses with `staffNoticesEnabled` and a staff group, so
batched-escalation notices are delivered without new traffic. The Inbox only hands out items the mode
permits, and the bridge's own Observe checks still apply to whatever it receives.

## Approval Pilot mode

`/config` may report `mode: "approval_pilot"` (between Observe and Assisted). The AI never sends on its own there. The bridge sends,
provided `AGENT_SEND_ENABLED=true`, only:

- `staff_notice`, `staff_draft`, `staff_feedback` to the configured staff group (`staffNoticesEnabled` is not needed), and
- `staff_relay`: a reply an explicitly authorized staff member approved in the staff group (`!approve`, `!send <text>`) or an admin sent from the
  dashboard. Human-authored, so the AI-reply checks (age, takeover, rate limits, commitment patterns) do not apply, but a hold after a send of unknown
  outcome (`held_after_unknown_send`) does.

Everything else (`customer_reply`, `holding_reply`, unknown kinds, a `staff_relay` addressed to a group) is refused and acked `failed` with
`approval_pilot_mode`. `/outbox/claim` is polled in this mode. An unknown mode still fails closed (`observe_mode`). The Inbox returns the draft's
approved text verbatim; the bridge never edits it. Deploy this bridge **before** switching any business to Approval Pilot.

