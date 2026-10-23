"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestSendInputError = void 0;
exports.startScheduler = startScheduler;
exports.stopScheduler = stopScheduler;
exports.sendScheduledTest = sendScheduledTest;
const config_js_1 = require("./config.js");
const supabase_js_1 = require("./supabase.js");
const whatsapp_js_1 = require("./whatsapp.js");
// Executor for scheduled messages. The schema and claim_due_schedule_runs()
// are owned by the inbox repo (20261007000000_scheduled_messages.sql); this
// file only claims runs and sends their pending deliveries. Delivery is
// at-most-once: a delivery is marked 'sending' before the socket call and a
// 'sending' row is never retried (stale ones become 'unknown').
//
// Logs carry ids, statuses and counts only — never message bodies or JIDs.
const CLAIM_LIMIT = 20;
const RUN_BATCH = 20;
const JID_PATTERN = /^[^@\s]+@(s\.whatsapp\.net|lid|g\.us)$/;
let timer;
let stopping = false;
let currentTick = null;
function log(message) {
    console.log(`[scheduler] ${message}`);
}
function errorText(error) {
    const text = error instanceof Error ? error.message : String(error);
    return text.slice(0, 500);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// 'sending' rows left by a crash or a hung send: the message may or may not
// have gone out, so mark unknown and never retry.
async function sweepStaleSending() {
    const cutoff = new Date(Date.now() - config_js_1.config.schedulerStaleSendingMs).toISOString();
    const { data, error } = await supabase_js_1.supabase
        .from("scheduled_message_deliveries")
        .update({ status: "unknown", error: "Stale 'sending' delivery; outcome unknown, not retried" })
        .eq("status", "sending")
        .lt("attempted_at", cutoff)
        .select("id");
    if (error) {
        console.error("[scheduler] stale sweep error:", error.message);
        return;
    }
    if (data?.length)
        log(`marked ${data.length} stale sending deliveries unknown`);
}
async function claimRuns() {
    const { data, error } = await supabase_js_1.supabase.rpc("claim_due_schedule_runs", {
        p_limit: CLAIM_LIMIT,
        p_worker: config_js_1.config.schedulerWorkerId
    });
    if (error) {
        console.error("[scheduler] claim error:", error.message);
        return;
    }
    const rows = (data ?? []);
    if (rows.length) {
        const pending = rows.filter((r) => r.out_status === "pending").length;
        log(`claimed ${rows.length} runs (${pending} to send)`);
    }
}
async function finalizeRun(runId) {
    const { data, error } = await supabase_js_1.supabase
        .from("scheduled_message_deliveries")
        .select("status")
        .eq("run_id", runId);
    if (error || !data) {
        console.error("[scheduler] finalize read error:", error?.message);
        return;
    }
    // Still has work (or an in-flight send): leave the run as 'running'.
    if (data.some((d) => d.status === "pending" || d.status === "sending"))
        return;
    const sent = data.filter((d) => d.status === "sent").length;
    const status = sent === data.length ? "completed" : sent === 0 ? "failed" : "partial";
    const failed = data.filter((d) => d.status === "failed").length;
    const unknown = data.filter((d) => d.status === "unknown").length;
    const { error: updateError } = await supabase_js_1.supabase
        .from("scheduled_message_runs")
        .update({
        status,
        finished_at: new Date().toISOString(),
        error: status === "completed" ? null : `sent=${sent} failed=${failed} unknown=${unknown}`
    })
        .eq("id", runId);
    if (updateError)
        console.error("[scheduler] finalize update error:", updateError.message);
    else
        log(`run ${runId} ${status} (sent=${sent} failed=${failed} unknown=${unknown})`);
}
// Returns true only if this process won the pending -> sending transition, so
// a delivery can never be sent twice.
async function markSending(deliveryId) {
    const { data, error } = await supabase_js_1.supabase
        .from("scheduled_message_deliveries")
        .update({ status: "sending", attempted_at: new Date().toISOString() })
        .eq("id", deliveryId)
        .eq("status", "pending")
        .select("id");
    if (error) {
        console.error("[scheduler] mark sending error:", error.message);
        return false;
    }
    return (data?.length ?? 0) === 1;
}
async function setDeliveryOutcome(deliveryId, patch) {
    const { error } = await supabase_js_1.supabase
        .from("scheduled_message_deliveries")
        .update(patch)
        .eq("id", deliveryId)
        .eq("status", "sending");
    if (error)
        console.error("[scheduler] delivery outcome error:", error.message);
}
// Shared by scheduled deliveries and the single-recipient test: performs the
// send and classifies the result. PreSendError => failed (nothing was sent);
// any other error => unknown (the message may have gone out).
async function sendAndClassify(businessSlug, jid, body) {
    try {
        const { messageId } = await (0, whatsapp_js_1.sendScheduledText)(businessSlug, jid, body);
        return { status: "sent", messageId, error: null };
    }
    catch (error) {
        if (error instanceof whatsapp_js_1.PreSendError) {
            return { status: "failed", messageId: null, error: errorText(error) };
        }
        return {
            status: "unknown",
            messageId: null,
            error: `Ambiguous send failure: ${errorText(error)}`
        };
    }
}
async function processRun(run) {
    const schedule = run.scheduled_messages;
    if (!schedule)
        return;
    // A run can outlive its claim (e.g. the bridge was down after claiming). The
    // claim RPC enforces the grace window for new runs; apply the same rule here
    // so a stale leftover is never sent late.
    const lateMs = Date.now() - new Date(run.scheduled_for).getTime();
    const graceMs = schedule.grace_minutes * 60_000;
    const { data: deliveries, error } = await supabase_js_1.supabase
        .from("scheduled_message_deliveries")
        .select("id, recipient_jid, status")
        .eq("run_id", run.id)
        .eq("status", "pending")
        .order("id");
    if (error) {
        console.error("[scheduler] read deliveries error:", error.message);
        return;
    }
    const pending = (deliveries ?? []);
    if (run.status === "pending") {
        const { data: started } = await supabase_js_1.supabase
            .from("scheduled_message_runs")
            .update({ status: "running", started_at: new Date().toISOString() })
            .eq("id", run.id)
            .eq("status", "pending")
            .select("id");
        if (!started?.length)
            return;
    }
    if (lateMs > graceMs && pending.length) {
        await supabase_js_1.supabase
            .from("scheduled_message_deliveries")
            .update({ status: "failed", error: "Missed grace window before sending" })
            .eq("run_id", run.id)
            .eq("status", "pending");
        await supabase_js_1.supabase
            .from("scheduled_message_runs")
            .update({
            status: "skipped_missed",
            finished_at: new Date().toISOString(),
            error: "Grace window passed before sending started"
        })
            .eq("id", run.id);
        log(`run ${run.id} skipped_missed before sending`);
        return;
    }
    for (let i = 0; i < pending.length; i++) {
        if (stopping)
            return;
        const delivery = pending[i];
        if (!(await markSending(delivery.id)))
            continue;
        const outcome = await sendAndClassify(schedule.business_slug, delivery.recipient_jid, run.message_body);
        if (outcome.status === "sent") {
            await setDeliveryOutcome(delivery.id, {
                status: "sent",
                whatsapp_message_id: outcome.messageId,
                sent_at: new Date().toISOString(),
                error: null
            });
        }
        else {
            await setDeliveryOutcome(delivery.id, { status: outcome.status, error: outcome.error });
        }
        log(`delivery ${delivery.id} ${outcome.status}`);
        if (i < pending.length - 1)
            await sleep(config_js_1.config.schedulerDelayMs);
    }
    if (!stopping)
        await finalizeRun(run.id);
}
async function tick() {
    await sweepStaleSending();
    await claimRuns();
    // Process every unfinished run, not just the ones claimed above, so runs
    // left over from a restart or a stopped tick are resumed.
    const { data, error } = await supabase_js_1.supabase
        .from("scheduled_message_runs")
        .select("id, schedule_id, scheduled_for, status, message_body, scheduled_messages(business_slug, grace_minutes)")
        .in("status", ["pending", "running"])
        .eq("trigger_type", "scheduled")
        .order("scheduled_for")
        .limit(RUN_BATCH);
    if (error) {
        console.error("[scheduler] read runs error:", error.message);
        return;
    }
    for (const run of (data ?? [])) {
        if (stopping)
            return;
        try {
            await processRun(run);
        }
        catch (err) {
            console.error(`[scheduler] run ${run.id} failed unexpectedly:`, errorText(err));
        }
    }
}
function scheduleNext() {
    if (stopping)
        return;
    timer = setTimeout(() => {
        // The next tick is only scheduled after this one finishes, so ticks can
        // never overlap.
        currentTick = tick()
            .catch((err) => console.error("[scheduler] tick error:", errorText(err)))
            .finally(() => {
            currentTick = null;
            scheduleNext();
        });
    }, config_js_1.config.schedulerPollMs);
}
function startScheduler() {
    if (timer || currentTick)
        return;
    stopping = false;
    log(`started worker=${config_js_1.config.schedulerWorkerId} pollMs=${config_js_1.config.schedulerPollMs} delayMs=${config_js_1.config.schedulerDelayMs}`);
    currentTick = tick()
        .catch((err) => console.error("[scheduler] tick error:", errorText(err)))
        .finally(() => {
        currentTick = null;
        scheduleNext();
    });
}
// Stops claiming new work and waits (bounded) for the in-flight tick to reach
// a delivery boundary. Unsent deliveries stay 'pending' and resume on restart
// if still inside the grace window.
async function stopScheduler(waitMs = 8_000) {
    stopping = true;
    if (timer)
        clearTimeout(timer);
    timer = undefined;
    if (currentTick) {
        await Promise.race([currentTick, sleep(waitMs)]);
    }
    log("stopped");
}
class TestSendInputError extends Error {
}
exports.TestSendInputError = TestSendInputError;
// Single-recipient test for the frontend. Uses the exact same send path and
// classification as scheduled deliveries. If scheduleId is given, the attempt
// is recorded as a trigger_type='test' run + delivery so it shows in history;
// recording is best-effort and never blocks or alters the send.
async function sendScheduledTest(input) {
    const { businessSlug, to, body, scheduleId } = input;
    if (!JID_PATTERN.test(to)) {
        throw new TestSendInputError("to must be a chat JID (@s.whatsapp.net, @lid or @g.us)");
    }
    if (!body.trim() || body.length > 4096) {
        throw new TestSendInputError("body must be 1-4096 characters");
    }
    let runId = null;
    let deliveryId = null;
    if (scheduleId) {
        const { data: schedule } = await supabase_js_1.supabase
            .from("scheduled_messages")
            .select("business_slug")
            .eq("id", scheduleId)
            .maybeSingle();
        if (!schedule)
            throw new TestSendInputError("Unknown scheduleId");
        if (schedule.business_slug !== businessSlug) {
            throw new TestSendInputError("scheduleId does not belong to businessSlug");
        }
        const now = new Date().toISOString();
        const { data: run, error: runError } = await supabase_js_1.supabase
            .from("scheduled_message_runs")
            .insert({
            schedule_id: scheduleId,
            scheduled_for: now,
            status: "running",
            trigger_type: "test",
            message_body: body,
            claimed_by: config_js_1.config.schedulerWorkerId,
            started_at: now
        })
            .select("id")
            .single();
        if (runError || !run) {
            console.error("[scheduler] test run record error:", runError?.message);
        }
        else {
            runId = run.id;
            const { data: delivery, error: deliveryError } = await supabase_js_1.supabase
                .from("scheduled_message_deliveries")
                .insert({
                run_id: runId,
                recipient_jid: to,
                status: "sending",
                attempted_at: now
            })
                .select("id")
                .single();
            if (deliveryError || !delivery) {
                console.error("[scheduler] test delivery record error:", deliveryError?.message);
            }
            else {
                deliveryId = delivery.id;
            }
        }
    }
    const outcome = await sendAndClassify(businessSlug, to, body);
    if (deliveryId) {
        await setDeliveryOutcome(deliveryId, outcome.status === "sent"
            ? {
                status: "sent",
                whatsapp_message_id: outcome.messageId,
                sent_at: new Date().toISOString(),
                error: null
            }
            : { status: outcome.status, error: outcome.error });
    }
    if (runId) {
        await supabase_js_1.supabase
            .from("scheduled_message_runs")
            .update({
            status: outcome.status === "sent" ? "completed" : outcome.status === "failed" ? "failed" : "partial",
            finished_at: new Date().toISOString(),
            error: outcome.error
        })
            .eq("id", runId);
    }
    return { ...outcome, recorded: Boolean(deliveryId) };
}
