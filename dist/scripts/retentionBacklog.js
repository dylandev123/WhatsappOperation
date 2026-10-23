"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Standalone backlog cleanup tool for the retention job (retention.ts),
// covering both stores it manages: the local media cache AND Supabase
// whatsapp_messages rows.
//
// Dry-run by default: reports what WOULD be deleted (count + GB for media,
// row count for messages, all older than RETENTION_DAYS) and makes no
// changes anywhere, local or remote. Pass --execute to actually delete —
// this calls the exact same runRetention() the daily cron job uses, so
// there is only one deletion code path for either store in the whole
// service, not a second one written just for this tool.
//
// Usage:
//   node dist/scripts/retentionBacklog.js            (dry run)
//   node dist/scripts/retentionBacklog.js --execute   (deletes both)
const retention_js_1 = require("../retention.js");
function formatGB(bytes) {
    return (bytes / 1024 ** 3).toFixed(2);
}
async function main() {
    const execute = process.argv.includes("--execute");
    const summary = await (0, retention_js_1.summarizeBacklog)();
    console.log("WhatsApp retention — backlog report");
    console.log(`  media root:              ${summary.mediaRoot}`);
    console.log(`  retention window:        ${retention_js_1.RETENTION_DAYS} days`);
    console.log(`  total files on disk:     ${summary.totalFiles}`);
    console.log(`  older than ${retention_js_1.RETENTION_DAYS} days:      ${summary.staleCount} files, ${formatGB(summary.staleBytes)} GB`);
    console.log(`  within ${retention_js_1.RETENTION_DAYS} days (kept):   ${summary.freshCount} files, ${formatGB(summary.freshBytes)} GB`);
    console.log(`  Supabase whatsapp_messages older than ${retention_js_1.RETENTION_DAYS} days: ${summary.staleMessageCount === null ? "unknown (count query failed)" : summary.staleMessageCount}`);
    if (summary.byBusiness.length) {
        console.log("  media by business (>7 days only):");
        for (const b of summary.byBusiness.sort((a, b) => b.bytes - a.bytes)) {
            console.log(`    ${b.businessSlug.padEnd(20)} ${String(b.count).padStart(6)} files  ${formatGB(b.bytes).padStart(8)} GB`);
        }
    }
    if (!execute) {
        console.log("\nDRY RUN — nothing was deleted (local media or Supabase).");
        console.log("Re-run with --execute to actually delete both.");
        return;
    }
    console.log("\n--execute passed — deleting media files and whatsapp_messages rows now...");
    const report = await (0, retention_js_1.runRetention)();
    if (report.aborted) {
        console.log(`ABORTED: ${report.abortReason}`);
        process.exitCode = 1;
        return;
    }
    console.log(`Deleted ${report.filesDeleted} media files (reclaimed ${formatGB(report.bytesReclaimed)} GB) and ${report.messagesDeleted} whatsapp_messages rows, ${report.failures.length} failures.`);
    if (report.messagesDeleteError) {
        console.log(`whatsapp_messages delete error: ${report.messagesDeleteError}`);
    }
    if (report.diskWarning) {
        console.log(`DISK WARNING: ${report.diskUsedPercent?.toFixed(1)}% used after cleanup.`);
    }
    if (report.failures.length) {
        process.exitCode = 1;
    }
}
main().catch((err) => {
    console.error("retention backlog tool failed:", err);
    process.exitCode = 1;
});
