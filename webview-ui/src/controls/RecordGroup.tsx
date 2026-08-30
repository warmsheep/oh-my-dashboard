import type { ModelOption, OpencodeSetting, RecordAggregate, RecordEditorValue } from "@shared/protocol";

import { isRecordEntriesLocked, isRecordMasterLocked } from "./helpers";
import RecordEditor from "./RecordEditor";

/**
 * recordMaster + recordEditor composite (formatter / lsp): the master three-way
 * select (未设置 / 启用内置 true / 全部关闭 false) above the named-entry editor.
 * File-shape interlocks mirror PermissionEditor: while named entries exist the
 * master select locks (已有条目 — writing the boolean would wipe them) and shows
 * the 未设置 placeholder; while the boolean form is set the entries area locks
 * (已设全局开关). Both commits go through the hosting tab's structured path with
 * full-snapshot semantics on the entries side.
 */
export default function RecordGroup({
  aggregate,
  masterDescriptor,
  entriesDescriptor,
  modelOptions,
  disabled,
  onMasterChange,
  onEntriesChange,
}: {
  /** Read-path aggregate of the shared path root (payload.records slot). */
  aggregate: RecordAggregate;
  /** The recordMaster descriptor (label of the master select). */
  masterDescriptor: OpencodeSetting;
  /** The paired recordEditor descriptor (entry field schemas + name rules). */
  entriesDescriptor: OpencodeSetting;
  /** Provider-grouped model options reused from the hosting tab's payload. */
  modelOptions: readonly ModelOption[];
  /** Pending-write disable shared with the hosting set-row. */
  disabled: boolean;
  /** Commit the master value (null = 未设置 → removes the key). */
  onMasterChange(next: boolean | null): void;
  /** Commit the full entries snapshot (null = empty → remove the key). */
  onEntriesChange(next: RecordEditorValue | null): void;
}) {
  const masterLocked = isRecordMasterLocked(aggregate);
  const entriesLocked = isRecordEntriesLocked(aggregate);
  const masterValue = aggregate.mode === "boolean" ? (aggregate.booleanValue === true ? "true" : "false") : "";

  return (
    <div className="ctl-list ctl-record-group">
      <div className="ctl-row">
        <span className="ctl-label">{masterDescriptor.label}</span>
        {masterLocked && <span className="set-row-hint">已有条目，清空条目后方可切换</span>}
        <select
          className="ctl"
          aria-label={masterDescriptor.label}
          disabled={disabled || masterLocked}
          value={masterValue}
          onChange={(e) => onMasterChange(e.target.value === "" ? null : e.target.value === "true")}
        >
          <option value="">未设置</option>
          <option value="true">启用内置</option>
          <option value="false">全部关闭</option>
        </select>
      </div>
      {entriesLocked && <span className="set-row-hint">已设全局开关</span>}
      <RecordEditor
        fields={entriesDescriptor.record?.fields ?? []}
        value={aggregate.entries}
        disabled={disabled || entriesLocked}
        modelOptions={modelOptions}
        nameRules={entriesDescriptor.record}
        onChange={onEntriesChange}
      />
    </div>
  );
}
