import type { PresetListEntry } from "@shared/protocol";

import { formatPresetDate } from "./helpers";
import { loadPresetDraft } from "./vscode";

/**
 * Default 模板 tab view: the preset list shown whenever no edit session is
 * open. Pure presentational — the edit request is delegated to the host via
 * onEdit (null = a new unsaved preset), which answers with the same `init`
 * message the editPreset command drives.
 */
export default function PresetListView({
  presets,
  onEdit,
}: {
  presets: PresetListEntry[] | null;
  onEdit: (name: string | null) => void;
}) {
  return (
    <section className="preset-list" aria-label="模板列表">
      <header className="plist-head">
        <span className="plist-title">模板</span>
        <button type="button" className="btn primary" onClick={() => onEdit(null)}>
          新建模板
        </button>
      </header>
      {presets === null ? (
        <div className="empty">正在加载模板列表…</div>
      ) : presets.length === 0 ? (
        <div className="empty">暂无模板——点击「新建模板」创建，或在侧栏「模板」分区右键「从当前配置捕获」。</div>
      ) : (
        <ul className="plist">
          {presets.map((preset) => (
            <PresetListRow key={preset.name} preset={preset} onEdit={onEdit} />
          ))}
        </ul>
      )}
    </section>
  );
}

// NOT memoized on purpose: the draft badge re-reads webview state per render —
// memo would skip re-renders when only the draft layer changed (e.g. cancel
// clears a draft while the presets array identity stays the same).
function PresetListRow({ preset, onEdit }: { preset: PresetListEntry; onEdit: (name: string | null) => void }) {
  // Webview-state drafts survive tab switches without a cancel (per-name slots);
  // surfacing them tells the user which rows reopen with unsaved edits.
  const hasDraft = loadPresetDraft(preset.name) !== undefined;
  return (
    <li>
      <button
        type="button"
        className="plist-item"
        onClick={() => onEdit(preset.name)}
        title={`编辑模板 ${preset.name}`}
      >
        <span className="plist-main">
          <span className="plist-name">{preset.name}</span>
          {preset.description && <span className="plist-desc">{preset.description}</span>}
          <span className="plist-meta">
            {formatPresetDate(preset.createdAt)} 创建
            {preset.appliedAt ? ` · ${formatPresetDate(preset.appliedAt)} 应用` : ""}
          </span>
        </span>
        {hasDraft && <span className="plist-badge">有未保存草稿</span>}
        <span className="plist-edit" aria-hidden="true">
          编辑 ›
        </span>
      </button>
    </li>
  );
}
