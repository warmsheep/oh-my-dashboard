import type { AgentTextMapValue } from "@shared/protocol";
import { useState } from "react";

import {
  agentTextRows,
  freeAgentTextRows,
  identifierKeyError,
  parseAgentTextInput,
  withAgentTextEntry,
  withoutAgentTextEntry,
} from "./helpers";

/**
 * agentTextMap-kind editor (系统提示词/提示词追加/分类提示词追加): one collapsible
 * row per descriptor agent (agent name + 已设置/未设置 badge + 展开) opening a
 * textarea. Commits fire on blur or the 完成 button (Enter inserts a newline — no
 * special casing); over-length drafts stay held with the inline ≤8000 error. Setting
 * an agent posts its text into the FULL map snapshot, clearing it posts a null
 * deletion marker; the snapshot NEVER collapses to whole-null (null = 无编辑,
 * never wipes the agents block). Text drafts are local state keyed by agent, so
 * configInit pushes never clobber in-progress typing. Free-key descriptors
 * (options absent, e.g. categories) render the live keys instead of a fixed row
 * set and gain a 新增键名 add-row (identifier-charset pre-check).
 */
export default function AgentTextMapEditor({
  value,
  agents,
  freeKeys = false,
  disabled,
  onChange,
}: {
  /** Current map; null = key absent, null entries = pending deletions (rendered 未设置). */
  value: AgentTextMapValue | null;
  /** Fixed agent rows in descriptor order (options = KNOWN_AGENTS); ignored in freeKeys mode. */
  agents: readonly string[];
  /** Free-key mode (descriptor options absent): rows come from the live map keys plus an add-row. */
  freeKeys?: boolean;
  /** Pending-write disable shared with the hosting set-row. */
  disabled: boolean;
  /** Commit the full map snapshot; an object is ALWAYS posted (never whole-null). */
  onChange(next: AgentTextMapValue | null): void;
}) {
  const rows = freeKeys ? freeAgentTextRows(value) : agentTextRows(agents, value);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [drafts, setDrafts] = useState<Partial<Record<string, string>>>({});
  const [newKey, setNewKey] = useState("");
  const [newText, setNewText] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const toggleExpanded = (agent: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(agent)) {
        next.delete(agent);
      } else {
        next.add(agent);
      }
      return next;
    });
  };

  /** Derived inline error of one agent's held draft (none once committed/cleared). */
  const errorOf = (agent: string): string | null => {
    const draft = drafts[agent];
    if (draft === undefined) {
      return null;
    }
    const parsed = parseAgentTextInput(draft);
    return parsed.kind === "invalid" ? parsed.error : null;
  };

  /** Blur / 完成 path: parse, then set, clear or no-op the agent's leaf. */
  const commit = (agent: string, raw: string) => {
    const parsed = parseAgentTextInput(raw);
    if (parsed.kind === "invalid") {
      // Keep the draft so the user can fix the text; the length error stays derived.
      return;
    }
    setDrafts((current) => {
      if (!(agent in current)) {
        return current;
      }
      const next = { ...current };
      delete next[agent];
      return next;
    });
    const live = value?.[agent];
    if (live !== undefined && live !== null) {
      if (parsed.value === null) {
        onChange(withoutAgentTextEntry(value, agent));
      } else if (parsed.value !== live) {
        onChange(withAgentTextEntry(value, agent, parsed.value));
      }
    } else if (parsed.value !== null) {
      onChange(withAgentTextEntry(value, agent, parsed.value));
    }
  };

  /** 新增键名 path (free-key mode): charset-checked key + bounded text land as one entry. */
  const addEntry = () => {
    const keyProblem = identifierKeyError(
      newKey,
      rows.map((row) => row.agent),
      "键名",
      // Host-side agentTextMap carries no entry cap — only the identifier rules apply.
      Number.POSITIVE_INFINITY,
    );
    if (keyProblem !== null) {
      setAddError(keyProblem);
      return;
    }
    const parsed = parseAgentTextInput(newText);
    if (parsed.kind === "invalid" || parsed.value === null) {
      setAddError(parsed.kind === "invalid" ? parsed.error : "文本不能为空");
      return;
    }
    onChange(withAgentTextEntry(value, newKey.trim(), parsed.value));
    setNewKey("");
    setNewText("");
    setAddError(null);
  };

  return (
    <div className="ctl-list ctl-agent-text">
      {rows.map((row) => {
        const isOpen = expanded.has(row.agent);
        return (
          <div key={row.agent}>
            <div className="ctl-row">
              <span className="ctl-text ctl-mono" title={row.agent}>
                {row.agent}
              </span>
              <span className="ctl-badge">{row.text === null ? "未设置" : "已设置"}</span>
              <button
                type="button"
                className="btn secondary ctl-x"
                disabled={disabled}
                aria-expanded={isOpen}
                onClick={() => toggleExpanded(row.agent)}
              >
                {isOpen ? "收起" : "展开"}
              </button>
            </div>
            {isOpen && (
              <div className="ctl-expand">
                <textarea
                  className="ctl ctl-textarea"
                  rows={6}
                  aria-label={`智能体 ${row.agent} 的文本`}
                  disabled={disabled}
                  value={drafts[row.agent] ?? row.text ?? ""}
                  onBlur={(e) => commit(row.agent, e.currentTarget.value)}
                  onChange={(e) => setDrafts((current) => ({ ...current, [row.agent]: e.target.value }))}
                />
                {errorOf(row.agent) !== null && (
                  <span className="ctl-inline-error" role="alert">
                    {errorOf(row.agent)}
                  </span>
                )}
                <button
                  type="button"
                  className="btn secondary ctl-x"
                  disabled={disabled}
                  onClick={() => commit(row.agent, drafts[row.agent] ?? row.text ?? "")}
                >
                  完成
                </button>
              </div>
            )}
          </div>
        );
      })}
      {freeKeys && (
        <div className="ctl-expand">
          <div className="ctl-row ctl-row-add">
            <input
              className="ctl ctl-add"
              type="text"
              placeholder="新键名"
              aria-label="新增键名"
              disabled={disabled}
              value={newKey}
              onChange={(e) => {
                setNewKey(e.target.value);
                setAddError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  addEntry();
                }
              }}
            />
            <button type="button" className="btn secondary ctl-x" disabled={disabled} onClick={addEntry}>
              添加
            </button>
          </div>
          <textarea
            className="ctl ctl-textarea"
            rows={3}
            aria-label="新键名的文本"
            disabled={disabled}
            value={newText}
            onChange={(e) => {
              setNewText(e.target.value);
              setAddError(null);
            }}
          />
          {addError !== null && (
            <span className="ctl-inline-error" role="alert">
              {addError}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
