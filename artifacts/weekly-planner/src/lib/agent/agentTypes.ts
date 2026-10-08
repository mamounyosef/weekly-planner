// ─── Planner agent: the shapes every side agrees on ──────────────────────────
//
// Shared verbatim by the server (agent-service.ts), the PC/browser panel and
// the Android app (copied into mobile/src/lib/agent/). Nothing in here may
// import anything platform-specific.
//
// THE REPORT IS NOT WRITTEN BY THE MODEL.
// A language model will happily say "Done, I added it" after calling a tool
// that does not exist (observed with gemma4 while designing this). So nothing
// the user reads as a record of what changed comes from model text. Every
// mutating tool returns a `ChangeSet` built by code from the records that were
// actually written and then read back from disk, and the report card renders
// those. The model's own words are shown too, but only as conversation.

export type AgentRole = 'user' | 'assistant';

/** An image or text file attached to a user message. Bytes live on the server. */
export interface AgentAttachment {
  id: string;
  kind: 'image' | 'text';
  name: string;
  mime: string;
  size: number;
  /** Pixel size, for laying out a thumbnail before it loads. Images only. */
  width?: number;
  height?: number;
}

/** One multiple-choice question, modelled on Claude Code's own question tool. */
export interface AgentQuestion {
  id: string;
  /** Short chip label, e.g. "Which day". */
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  /** The user may always type their own answer instead. */
  allowOther: boolean;
}

export interface AgentQuestionAnswer {
  questionId: string;
  /** Labels of the chosen options, in the order the options were offered. */
  selected: string[];
  /** Free text typed as "Other", or a note added to a selection. */
  other?: string;
}

/** One item the agent wants to delete, exactly as it will be deleted. */
export interface PendingDeletion {
  /** The id the model passed (may be an occurrence id "<master>::<date>"). */
  id: string;
  kind: 'event' | 'task' | 'focus_session';
  title: string;
  /** Human description of the scope, e.g. "Only Tue 29 Sep" or "The whole series". */
  scopeLabel: string;
  /** Where/when it is, in words, e.g. "Tue 29 Sep, 5:00 PM to 6:00 PM". */
  when: string;
  repeats?: string;
}

export interface AgentApproval {
  id: string;
  reason: string;
  deletions: PendingDeletion[];
}

// ─── The ground-truth change record ─────────────────────────────────────────

export type ChangeAction = 'added' | 'updated' | 'deleted' | 'completed' | 'reopened' | 'skipped' | 'failed';

/** A plain, display-ready snapshot of one calendar item at one moment. */
export interface ItemFacts {
  title: string;
  kind: 'event' | 'task' | 'focus_session';
  /** 'yyyy-MM-dd' of the (first) occurrence; absent for a task with no date. */
  date?: string;
  /** Last day of a multi-day all-day event, inclusive. */
  endDate?: string;
  startTime?: string;
  endTime?: string;
  allDay?: boolean;
  pointInTime?: boolean;
  /** True when the end time is on the following day. */
  overnight?: boolean;
  category?: string;
  color?: string;
  list?: string;
  repeats?: string;
  reminders?: string;
  checkbox?: boolean;
  done?: boolean;
  notes?: string;
}

export interface ChangeEntry {
  action: ChangeAction;
  kind: 'event' | 'task' | 'focus_session';
  /** The stored record id (never an occurrence id). */
  id: string;
  /** What it looks like now (absent for a delete). */
  after?: ItemFacts;
  /** What it looked like before (absent for an add). */
  before?: ItemFacts;
  /** Field names that changed, for updates, in display order. */
  changed?: string[];
  /** One line of context, e.g. "Only this occurrence (Tue 29 Sep) was moved". */
  note?: string;
  /** True once the record was read back from disk after the write and matched. */
  verified: boolean;
}

export interface ChangeSet {
  id: string;
  at: number;
  /** The tool that produced it. */
  tool: string;
  entries: ChangeEntry[];
  /** Set once the user pressed Undo and the undo succeeded. */
  undoneAt?: number;
  /** Why an undo could not restore some items (they changed since). */
  undoNote?: string;
}

// ─── Conversation ───────────────────────────────────────────────────────────

export interface AgentToolTrace {
  id: string;
  name: string;
  /** Short human label, e.g. "Checked your calendar for 9 Oct to 10 Oct". */
  label: string;
  status: 'running' | 'ok' | 'error' | 'rejected';
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface AgentMessage {
  id: string;
  role: AgentRole;
  at: number;
  text: string;
  attachments?: AgentAttachment[];
  /** Assistant only: its private reasoning, shown collapsed. */
  thinking?: string;
  /** Assistant only: the tools it ran while producing this message. */
  tools?: AgentToolTrace[];
  /** Assistant only: questions it is waiting on (or already answered). */
  questions?: AgentQuestion[];
  answers?: AgentQuestionAnswer[];
  /** Assistant only: a deletion waiting for approval (or already decided). */
  approval?: AgentApproval;
  approvalDecision?: { approved: boolean; at: number; note?: string };
  /** Assistant only: ids of the change sets this turn produced. */
  changeSetIds?: string[];
  /** Assistant only: the turn ended in an error the user should see. */
  error?: string;
}

export type RunState =
  | 'idle'
  | 'running'
  | 'awaiting_answer'
  | 'awaiting_approval'
  | 'error';

export interface AgentConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: AgentMessage[];
  changeSets: Record<string, ChangeSet>;
  state: RunState;
  /** Model used for this conversation. */
  model: string;
  /** Partial text of the assistant turn being generated right now. */
  liveText?: string;
  liveThinking?: string;
}

export interface AgentConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  state: RunState;
  messageCount: number;
  preview: string;
}

// ─── Wire events (server -> client stream) ───────────────────────────────────

export type AgentStreamEvent =
  /** The whole conversation, sent on connect and after every durable change. */
  | { type: 'conversation'; conversation: AgentConversation }
  /** A token delta for the turn in progress. */
  | { type: 'delta'; conversationId: string; text?: string; thinking?: string }
  /** The list of conversations changed (created, renamed, deleted). */
  | { type: 'list'; conversations: AgentConversationSummary[] };

/** Upper bounds shared by both sides so a client can refuse before uploading. */
export const AGENT_LIMITS = {
  maxAttachments: 12,
  maxImageBytes: 12 * 1024 * 1024,
  maxTextBytes: 400 * 1024,
  maxMessageChars: 20_000,
} as const;
