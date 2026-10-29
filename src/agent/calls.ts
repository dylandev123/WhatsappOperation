import type { CallReportPayload } from "./types.js";

// Turns Baileys `call` events into ONE report per finished call, with only the facts the bridge can actually know.
//
// What Baileys 6.7 delivers for a call: status "offer" (with isVideo / isGroup), "ringing", "accept", "reject", "timeout",
// "terminate". "timeout" is the server's terminate with reason "timeout": the call rang out. "terminate" with any other reason
// is sent when the caller hangs up, when somebody accepted, when it was rejected, and for a call answered on another device, so
// by itself it does not say the call was missed: it is reported as "terminate" and the Inbox treats it as uncertain.
// A call stays "uncertain" when this process never saw its offer (it connected mid-call, or the event was an offline replay).
//
// This file decides nothing about replying. It only states what was seen; the Inbox re-checks it (lib/aiAgent/missedCalls.ts) and
// stays silent unless the missed-call rule is on.

export type CallEventLike = {
  chatId?: string;
  from?: string;
  id: string;
  date?: Date | string | number;
  isVideo?: boolean;
  isGroup?: boolean;
  groupJid?: string;
  status: string;
  offline?: boolean;
};

type CallState = {
  callerJid: string | null;
  outgoing: boolean;
  isGroup: boolean;
  isVideo: boolean | null;
  offline: boolean;
  sawOffer: boolean;
  sawAccept: boolean;
  sawReject: boolean;
  offerAt: number | null;
  reported: boolean;
  seenAt: number;
};

const FINAL = new Set(["timeout", "terminate", "accept", "reject"]);
const KEEP_MS = 15 * 60_000;
const MAX_CALLS = 500;
const DIRECT_JID = /^[^@\s]+@(s\.whatsapp\.net|lid)$/;

/** "17585550102:12@s.whatsapp.net" → "17585550102@s.whatsapp.net" (the device part is not part of the chat). */
export function normalizeJid(jid: string | undefined | null): string | null {
  if (!jid) return null;
  const at = jid.indexOf("@");
  if (at < 1) return null;
  return `${jid.slice(0, at).split(":")[0]}${jid.slice(at)}`;
}

const userOf = (jid: string | undefined | null) => normalizeJid(jid)?.split("@")[0] ?? null;

const toMs = (d: CallEventLike["date"]): number | null => {
  if (d === undefined || d === null) return null;
  const ms = d instanceof Date ? d.getTime() : typeof d === "number" ? d : Date.parse(d);
  return Number.isFinite(ms) ? ms : null;
};
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export class CallTracker {
  private calls = new Map<string, CallState>();

  constructor(private now: () => number = Date.now) {}

  /** `selfIds`: this account's own JIDs (phone and LID form); a call created by one of them is outgoing. */
  handle(businessSlug: string, event: CallEventLike, selfIds: Array<string | undefined | null>): CallReportPayload | null {
    this.prune();
    const key = `${businessSlug}|${event.id}`;
    let state = this.calls.get(key);
    if (!state) {
      state = { callerJid: null, outgoing: false, isGroup: false, isVideo: null, offline: false, sawOffer: false, sawAccept: false, sawReject: false, offerAt: null, reported: false, seenAt: this.now() };
      this.calls.set(key, state);
    }
    state.seenAt = this.now();
    if (state.reported) return null;

    const selfUsers = new Set(selfIds.map(userOf).filter((u): u is string => Boolean(u)));
    const creator = userOf(event.from) ?? userOf(event.chatId);
    if (creator && selfUsers.has(creator)) state.outgoing = true;
    // The caller's chat: the call stanza's sender when it is a person, else the creator.
    const direct = [normalizeJid(event.chatId), normalizeJid(event.from)].find((j) => j && DIRECT_JID.test(j)) ?? null;
    if (direct && !state.callerJid) state.callerJid = direct;
    if (event.isGroup === true || Boolean(event.groupJid) || (event.chatId ?? "").endsWith("@g.us")) state.isGroup = true;
    if (typeof event.isVideo === "boolean") state.isVideo = event.isVideo;
    // Any event of the call that was an offline replay makes the whole call uncertain.
    if (event.offline === true) state.offline = true;

    switch (event.status) {
      case "offer":
        state.sawOffer = true;
        state.offerAt = toMs(event.date) ?? this.now();
        return null;
      case "accept":
        state.sawAccept = true;
        break;
      case "reject":
        state.sawReject = true;
        break;
      default:
        break;
    }
    if (!FINAL.has(event.status)) return null;

    state.reported = true;
    const callerJid = state.callerJid ?? normalizeJid(event.chatId) ?? normalizeJid(event.from);
    if (!callerJid) return null;
    return {
      businessSlug,
      callId: event.id,
      callerJid,
      outgoing: state.outgoing,
      isGroup: state.isGroup,
      isVideo: state.isVideo,
      offline: state.offline,
      sawOffer: state.sawOffer,
      sawAccept: state.sawAccept,
      sawReject: state.sawReject,
      finalStatus: event.status as CallReportPayload["finalStatus"],
      offerAt: iso(state.offerAt),
      endedAt: iso(toMs(event.date) ?? this.now())
    };
  }

  private prune() {
    const cutoff = this.now() - KEEP_MS;
    for (const [key, state] of this.calls) if (state.seenAt < cutoff) this.calls.delete(key);
    while (this.calls.size > MAX_CALLS) {
      const oldest = this.calls.keys().next().value;
      if (oldest === undefined) break;
      this.calls.delete(oldest);
    }
  }
}
