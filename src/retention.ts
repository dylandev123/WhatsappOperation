// 7-day retention for the WhatsApp bridge, covering two independent stores:
//
//   1. Local disk: the downloaded media cache under config.mediaDir. This
//      service has no local chat-text store — message content only ever
//      lives in Supabase (see saveMessage() in supabase.ts) and briefly in
//      each session's in-memory maps (whatsapp.ts), never written to disk.
//      So "local chat history" and "local cached media" are the same thing
//      here: prune stale files under the media root. auth/ (Baileys
//      credentials/session keys) is never a candidate root — excluded by
//      construction, not by a runtime check alone (resolveApprovedMediaRoot()).
//
//   2. Supabase `whatsapp_messages`: the raw message rows themselves. This
//      table has no foreign key pointing at it anywhere in the schema —
//      customers/conversation_status/conversation_analysis all key off
//      (business_slug, chat_id) or phone_number, never whatsapp_messages.id
//      — so deleting old rows here cannot cascade into or otherwise touch
//      customer profiles, AI profile data, or conversation metadata. See
//      deleteStaleMessages() in supabase.ts.
//
// Both are gated by the single isSupabaseReachable() guard below: if
// Supabase can't be confirmed reachable (which also confirms the customers
// table specifically), nothing is deleted — local or remote.
import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { isSupabaseReachable, countStaleMessages, deleteStaleMessages } from "./supabase.js";

export const RETENTION_DAYS = 7;
export const DISK_WARNING_PERCENT = 85;

interface CandidateFile {
  businessSlug: string;
  absPath: string;
  size: number;
  mtimeMs: number;
}

export interface DeletionLogEntry {
  businessSlug: string;
  file: string;
  bytes: number;
  ageDays: number;
}

export interface FailureLogEntry {
  businessSlug: string;
  file: string;
  error: string;
}

export interface RetentionReport {
  ranAt: string;
  supabaseReachable: boolean;
  mediaRoot: string;
  filesScanned: number;
  filesDeleted: number;
  bytesReclaimed: number;
  deletions: DeletionLogEntry[];
  failures: FailureLogEntry[];
  messagesDeleted: number;
  messagesDeleteError: string | null;
  diskUsedPercent: number | null;
  diskFreeBytes: number | null;
  diskWarning: boolean;
  aborted: boolean;
  abortReason?: string;
}

export interface BacklogSummary {
  mediaRoot: string;
  retentionDays: number;
  totalFiles: number;
  staleCount: number;
  staleBytes: number;
  freshCount: number;
  freshBytes: number;
  byBusiness: Array<{ businessSlug: string; count: number; bytes: number }>;
  // null means the Supabase count query itself failed (not "zero stale
  // messages") — the backlog tool reports this distinctly.
  staleMessageCount: number | null;
}

// Resolves the one approved deletion root (the media cache) and asserts, at
// runtime, that it cannot be — or contain, or be contained by — the auth
// root. This is a hard abort, not a skip: if this ever fails, something is
// badly misconfigured and no deletion should proceed at all.
function resolveApprovedMediaRoot(): string {
  const mediaRoot = fs.realpathSync(path.resolve(config.mediaDir));

  if (path.basename(mediaRoot) !== "media" || mediaRoot.split(path.sep).filter(Boolean).length < 2) {
    throw new Error(`Refusing to run retention: media root "${mediaRoot}" doesn't look like a media cache dir`);
  }

  if (fs.existsSync(config.authDir)) {
    const authRoot = fs.realpathSync(path.resolve(config.authDir));
    const overlaps =
      mediaRoot === authRoot ||
      mediaRoot.startsWith(authRoot + path.sep) ||
      authRoot.startsWith(mediaRoot + path.sep);

    if (overlaps) {
      throw new Error(`Refusing to run retention: media root "${mediaRoot}" overlaps auth root "${authRoot}"`);
    }
  }

  return mediaRoot;
}

// Resolves candidatePath and confirms the resolved real path is actually
// inside realRoot. Using realpath (not just string-prefix on the unresolved
// path) means a symlink anywhere in the chain that would escape the
// approved root gets caught here, not followed.
function resolveSafelyWithinRoot(realRoot: string, candidatePath: string): string | null {
  let real: string;
  try {
    real = fs.realpathSync(candidatePath);
  } catch {
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  return real;
}

function collectMediaFiles(mediaRoot: string): CandidateFile[] {
  const results: CandidateFile[] = [];

  let businessDirs: fs.Dirent[];
  try {
    businessDirs = fs.readdirSync(mediaRoot, { withFileTypes: true });
  } catch (err) {
    console.error(`[retention] failed to read media root ${mediaRoot}:`, err);
    return results;
  }

  for (const entry of businessDirs) {
    // Dirent.isDirectory() reflects the entry itself, not a followed
    // symlink target, so a symlinked "business" dir is skipped here.
    if (!entry.isDirectory()) continue;

    const businessSlug = entry.name;
    const dirPath = path.join(mediaRoot, businessSlug);
    const realDirPath = resolveSafelyWithinRoot(mediaRoot, dirPath);
    if (!realDirPath) {
      console.error(`[retention] SAFETY: skipping "${dirPath}" — resolves outside the approved media root`);
      continue;
    }

    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (err) {
      console.error(`[retention] failed to read ${dirPath}:`, err);
      continue;
    }

    for (const file of files) {
      // Same Dirent guard as above — symlinked "files" are skipped, not
      // followed.
      if (!file.isFile()) continue;

      const filePath = path.join(dirPath, file.name);
      const realFilePath = resolveSafelyWithinRoot(mediaRoot, filePath);
      if (!realFilePath) {
        console.error(`[retention] SAFETY: skipping "${filePath}" — resolves outside the approved media root`);
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      results.push({ businessSlug, absPath: realFilePath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }

  return results;
}

function checkDiskUsage(targetPath: string): { usedPercent: number | null; freeBytes: number | null } {
  try {
    const stats = fs.statfsSync(targetPath);
    const totalBlocks = stats.blocks;
    const freeBlocks = stats.bavail;
    if (totalBlocks <= 0) return { usedPercent: null, freeBytes: null };
    const usedPercent = ((totalBlocks - freeBlocks) / totalBlocks) * 100;
    return { usedPercent, freeBytes: freeBlocks * stats.bsize };
  } catch (err) {
    console.error("[retention] failed to read disk usage:", err);
    return { usedPercent: null, freeBytes: null };
  }
}

function scanCandidates(): { mediaRoot: string; files: CandidateFile[]; cutoffMs: number } {
  const mediaRoot = resolveApprovedMediaRoot();
  const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = collectMediaFiles(mediaRoot);
  return { mediaRoot, files, cutoffMs };
}

// Read-only: used by both the daily job's pre-flight log and the backlog
// dry-run tool. Never deletes anything — including from Supabase (the
// message count below is a plain SELECT COUNT, not a delete).
export async function summarizeBacklog(): Promise<BacklogSummary> {
  const { mediaRoot, files, cutoffMs } = scanCandidates();
  const stale = files.filter((f) => f.mtimeMs < cutoffMs);
  const fresh = files.filter((f) => f.mtimeMs >= cutoffMs);

  const byBusiness = new Map<string, { count: number; bytes: number }>();
  for (const f of stale) {
    const agg = byBusiness.get(f.businessSlug) || { count: 0, bytes: 0 };
    agg.count += 1;
    agg.bytes += f.size;
    byBusiness.set(f.businessSlug, agg);
  }

  const staleMessageCount = await countStaleMessages(new Date(cutoffMs).toISOString());

  return {
    mediaRoot,
    retentionDays: RETENTION_DAYS,
    totalFiles: files.length,
    staleCount: stale.length,
    staleBytes: stale.reduce((sum, f) => sum + f.size, 0),
    freshCount: fresh.length,
    freshBytes: fresh.reduce((sum, f) => sum + f.size, 0),
    byBusiness: Array.from(byBusiness.entries()).map(([businessSlug, agg]) => ({ businessSlug, ...agg })),
    staleMessageCount
  };
}

// The one function that actually deletes anything. Used by both the daily
// cron entrypoint below and the backlog tool's --execute path, so there is
// exactly one deletion code path to trust.
export async function runRetention(): Promise<RetentionReport> {
  const ranAt = new Date().toISOString();
  const deletions: DeletionLogEntry[] = [];
  const failures: FailureLogEntry[] = [];

  let mediaRoot: string;
  try {
    mediaRoot = resolveApprovedMediaRoot();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[retention] ABORTED: ${reason}`);
    return {
      ranAt,
      supabaseReachable: false,
      mediaRoot: "",
      filesScanned: 0,
      filesDeleted: 0,
      bytesReclaimed: 0,
      deletions,
      failures,
      messagesDeleted: 0,
      messagesDeleteError: null,
      diskUsedPercent: null,
      diskFreeBytes: null,
      diskWarning: false,
      aborted: true,
      abortReason: reason
    };
  }

  // Never delete local media OR whatsapp_messages rows before confirming the
  // durable side (Supabase, including the customers profile table
  // specifically — see isSupabaseReachable()) is reachable. If it's down, we
  // can't be sure today's rows/profile updates landed there, so skip ALL
  // deletion for this run rather than risk losing the only copy of
  // something.
  const supabaseReachable = await isSupabaseReachable();
  if (!supabaseReachable) {
    const reason = "Supabase unreachable — skipping all deletion (local media + whatsapp_messages) so nothing is removed before the durable record is confirmed saved";
    console.error(`[retention] ABORTED: ${reason}`);
    return {
      ranAt,
      supabaseReachable,
      mediaRoot,
      filesScanned: 0,
      filesDeleted: 0,
      bytesReclaimed: 0,
      deletions,
      failures,
      messagesDeleted: 0,
      messagesDeleteError: null,
      diskUsedPercent: null,
      diskFreeBytes: null,
      diskWarning: false,
      aborted: true,
      abortReason: reason
    };
  }

  const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = collectMediaFiles(mediaRoot);
  const stale = files.filter((f) => f.mtimeMs < cutoffMs);

  let bytesReclaimed = 0;
  for (const file of stale) {
    try {
      fs.unlinkSync(file.absPath);
      bytesReclaimed += file.size;
      const entry: DeletionLogEntry = {
        businessSlug: file.businessSlug,
        file: file.absPath,
        bytes: file.size,
        ageDays: Math.floor((Date.now() - file.mtimeMs) / (24 * 60 * 60 * 1000))
      };
      deletions.push(entry);
      console.log(
        `[retention] deleted business=${entry.businessSlug} file=${path.basename(entry.file)} bytes=${entry.bytes} age_days=${entry.ageDays}`
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ businessSlug: file.businessSlug, file: file.absPath, error });
      console.error(`[retention] FAILED business=${file.businessSlug} file=${path.basename(file.absPath)}: ${error}`);
    }
  }

  // whatsapp_messages cleanup — same cutoff, independent store. Failures
  // here are logged and reported but don't roll back the media deletion
  // above (different resource, already committed file-by-file).
  const cutoffIso = new Date(cutoffMs).toISOString();
  const { deletedCount: messagesDeleted, error: messagesDeleteError } = await deleteStaleMessages(cutoffIso);
  if (messagesDeleteError) {
    failures.push({ businessSlug: "*", file: "whatsapp_messages", error: messagesDeleteError });
    console.error(`[retention] FAILED whatsapp_messages delete: ${messagesDeleteError}`);
  } else {
    console.log(`[retention] deleted whatsapp_messages rows=${messagesDeleted} (older than ${RETENTION_DAYS} days)`);
  }

  const { usedPercent, freeBytes } = checkDiskUsage(mediaRoot);
  const diskWarning = usedPercent !== null && usedPercent > DISK_WARNING_PERCENT;
  if (diskWarning) {
    const freeGb = freeBytes !== null ? (freeBytes / 1024 ** 3).toFixed(2) : "unknown";
    console.warn(
      `[retention] DISK WARNING: ${usedPercent!.toFixed(1)}% used on filesystem containing ${mediaRoot} (${freeGb} GB free, threshold ${DISK_WARNING_PERCENT}%)`
    );
  }

  console.log(
    `[retention] SUMMARY ran_at=${ranAt} files_scanned=${files.length} media_deleted=${deletions.length} bytes_reclaimed=${bytesReclaimed} messages_deleted=${messagesDeleted} failures=${failures.length} disk_used_pct=${usedPercent?.toFixed(1) ?? "unknown"}`
  );

  return {
    ranAt,
    supabaseReachable,
    mediaRoot,
    filesScanned: files.length,
    filesDeleted: deletions.length,
    bytesReclaimed,
    deletions,
    failures,
    messagesDeleted,
    messagesDeleteError,
    diskUsedPercent: usedPercent,
    diskFreeBytes: freeBytes,
    diskWarning,
    aborted: false
  };
}

// CLI entrypoint for the daily cron job: `node dist/retention.js`, runs
// once and exits. Not used by the backlog tool (which imports the
// functions above directly and controls its own --execute gating).
if (require.main === module) {
  runRetention()
    .then((report) => {
      process.exitCode = report.aborted || report.failures.length > 0 ? 1 : 0;
    })
    .catch((err) => {
      console.error("[retention] fatal error:", err);
      process.exitCode = 1;
    });
}
