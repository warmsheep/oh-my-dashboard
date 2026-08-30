import type { OpencodePermissionState } from "@shared/protocol";
import { OPENCODE_PERMISSION_TOOLS } from "@shared/protocol";

import { isPermissionShorthandLocked, isPermissionToolsLocked, type PermissionAction } from "./helpers";

/**
 * permissionTools-kind editor: the 简写 row (未设置/allow/ask/deny) plus one row per
 * OPENCODE_PERMISSION_TOOLS entry. Writes are per-key single-entry maps — the host
 * applies edits only for keys PRESENT in the posted value (null removes that tool's
 * key), so each tool row commits exactly { tool: action }. Interlocks protect the
 * file shape: the shorthand select is disabled while the object form is set
 * (已按工具设置 — writing the string would wipe the per-tool rules), tool rows are
 * disabled while the string form is set (已设全局简写), and a tool whose value is a
 * hand-written pattern object shows the 高级规则 badge with a disabled select.
 */
export default function PermissionEditor({
  state,
  disabled,
  onShorthandChange,
  onToolChange,
}: {
  /** Read-path aggregate from the tab payload (NOT the scalar values map). */
  state: OpencodePermissionState;
  /** Pending-write disable shared with the hosting set-row. */
  disabled: boolean;
  /** Commit the global shorthand (null = 未设置 → removes the permission key). */
  onShorthandChange(next: PermissionAction | null): void;
  /** Commit one tool's action as a single-key map (null removes that tool's key). */
  onToolChange(tool: string, next: PermissionAction | null): void;
}) {
  const shorthandLocked = isPermissionShorthandLocked(state);
  const toolsLocked = isPermissionToolsLocked(state);

  return (
    <div className="ctl-list ctl-perm">
      <div className="ctl-row">
        <span className="ctl-label">全局简写</span>
        {shorthandLocked && <span className="set-row-hint">已按工具设置</span>}
        <select
          className="ctl"
          aria-label="全局权限简写"
          disabled={disabled || shorthandLocked}
          value={state.shorthand ?? ""}
          onChange={(e) => {
            const next = e.target.value === "" ? null : (e.target.value as PermissionAction);
            if (next !== (state.shorthand ?? null)) {
              onShorthandChange(next);
            }
          }}
        >
          <option value="">未设置</option>
          <option value="allow">allow</option>
          <option value="ask">ask</option>
          <option value="deny">deny</option>
        </select>
      </div>
      {toolsLocked && <span className="set-row-hint">已设全局简写</span>}
      {OPENCODE_PERMISSION_TOOLS.map((tool) => {
        const advanced = state.advancedTools.includes(tool);
        return (
          <div className="ctl-row" key={tool}>
            <span className="ctl-text ctl-mono" title={tool}>
              {tool}
            </span>
            {advanced && <span className="ctl-badge">高级规则</span>}
            <select
              className="ctl"
              aria-label={`工具 ${tool} 的权限`}
              disabled={disabled || toolsLocked || advanced}
              value={state.tools[tool] ?? ""}
              onChange={(e) => {
                const next = e.target.value === "" ? null : (e.target.value as PermissionAction);
                if (next !== (state.tools[tool] ?? null)) {
                  onToolChange(tool, next);
                }
              }}
            >
              <option value="">未设置</option>
              <option value="allow">allow</option>
              <option value="ask">ask</option>
              <option value="deny">deny</option>
            </select>
          </div>
        );
      })}
    </div>
  );
}
