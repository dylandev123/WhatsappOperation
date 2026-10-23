"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.emptyJournalState = emptyJournalState;
exports.createMemoryJournal = createMemoryJournal;
exports.createFileJournal = createFileJournal;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
function emptyJournalState() {
    return {
        version: 1,
        forwards: [],
        outbox: {},
        forwarded: {},
        customerActivity: {},
        humanActivity: {},
        holds: {},
        lastClaimAt: {}
    };
}
function createMemoryJournal(state = emptyJournalState()) {
    return {
        state,
        saves: 0,
        save() {
            this.saves += 1;
        }
    };
}
function createFileJournal(file, log = console.log) {
    let state = emptyJournalState();
    if (fs_1.default.existsSync(file)) {
        try {
            state = { ...emptyJournalState(), ...JSON.parse(fs_1.default.readFileSync(file, "utf8")) };
        }
        catch (error) {
            // Keep the unreadable file for inspection; starting empty can lose
            // pending forwards but can never cause a resend.
            const aside = `${file}.corrupt-${Date.now()}`;
            fs_1.default.renameSync(file, aside);
            log(`journal unreadable, moved to ${aside}: ${error instanceof Error ? error.message : error}`);
        }
    }
    fs_1.default.mkdirSync(path_1.default.dirname(file), { recursive: true });
    return {
        get state() {
            return state;
        },
        save() {
            const tmp = `${file}.tmp`;
            const fd = fs_1.default.openSync(tmp, "w");
            try {
                fs_1.default.writeFileSync(fd, JSON.stringify(state));
                fs_1.default.fsyncSync(fd);
            }
            finally {
                fs_1.default.closeSync(fd);
            }
            fs_1.default.renameSync(tmp, file);
        }
    };
}
