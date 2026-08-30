import type { AgentPairMapValue, ModelOption } from "@shared/protocol";
import { useMemo } from "react";

import { groupModelsByProvider } from "../helpers";
import { agentPairRows, isAgentPairReasoningLocked, withAgentPairEntry, withoutAgentPairEntry } from "./helpers";

/**
 * agentPairMap-kind editor (超级工作/压缩覆写): one FIXED row per descriptor agent
 * (agent name + model select + reasoning select). ANY change commits the FULL map
 * snapshot — clearing a set row posts a null deletion marker for that agent, and
 * the snapshot NEVER collapses to whole-null (null = 无编辑, never wipes the
 * agents block), so per-agent removals always ride an object. Reasoning requires
 * a model (core validator), so its select stays locked until a model is chosen;
 * re-choosing the model keeps the current reasoning.
 */
export default function AgentPairMapEditor({
  value,
  agents,
  models,
  reasoningLevels,
  disabled,
  onChange,
}: {
  /** Current map; null = key absent, null entries = pending deletions (rendered 未设置). */
  value: AgentPairMapValue | null;
  /** Fixed agent rows in descriptor order (options = KNOWN_AGENTS). */
  agents: readonly string[];
  /** Model options reused from the hosting tab's payload. */
  models: readonly ModelOption[];
  /** Selectable reasoning levels (OMO_REASONING_LEVELS). */
  reasoningLevels: readonly string[];
  /** Pending-write disable shared with the hosting set-row. */
  disabled: boolean;
  /** Commit the full map snapshot; an object is ALWAYS posted (never whole-null). */
  onChange(next: AgentPairMapValue | null): void;
}) {
  const rows = useMemo(() => agentPairRows(agents, value), [agents, value]);
  const groups = useMemo(() => groupModelsByProvider(models), [models]);
  const modelIds = useMemo(() => new Set(models.map((m) => m.id)), [models]);

  /** Provider-grouped options; a configured model missing from the catalog stays visible. */
  const renderModelOptions = (current: string) => (
    <>
      {[...groups].map(([provider, opts]) => (
        <optgroup key={provider} label={provider}>
          {opts.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.id})
            </option>
          ))}
        </optgroup>
      ))}
      {current !== "" && !modelIds.has(current) && <option value={current}>{current}</option>}
    </>
  );

  return (
    <div className="ctl-list ctl-agent-map">
      {models.length === 0 && <span className="set-row-hint">模型清单为空，暂无可选模型</span>}
      {rows.map((row) => (
        <div className="ctl-row" key={row.agent}>
          <span className="ctl-text ctl-mono" title={row.agent}>
            {row.agent}
          </span>
          <select
            className="ctl sel-model"
            aria-label={`智能体 ${row.agent} 的模型`}
            disabled={disabled}
            value={row.entry?.model ?? ""}
            onChange={(e) => {
              const model = e.target.value;
              if (model === "") {
                // 未设置 clears the row; an already-unset row is a normalized no-op.
                if (row.entry !== null) {
                  onChange(withoutAgentPairEntry(value, row.agent));
                }
                return;
              }
              onChange(
                withAgentPairEntry(value, row.agent, {
                  model,
                  reasoning: row.entry?.reasoning ?? null,
                }),
              );
            }}
          >
            <option value="">未设置</option>
            {renderModelOptions(row.entry?.model ?? "")}
          </select>
          <select
            className="ctl sel-variant"
            aria-label={`智能体 ${row.agent} 的 reasoning`}
            disabled={disabled || isAgentPairReasoningLocked(row)}
            value={row.entry?.reasoning ?? ""}
            onChange={(e) => {
              if (row.entry === null) {
                return;
              }
              onChange(
                withAgentPairEntry(value, row.agent, {
                  model: row.entry.model,
                  reasoning: e.target.value === "" ? null : e.target.value,
                }),
              );
            }}
          >
            <option value="">未设置</option>
            {reasoningLevels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}
