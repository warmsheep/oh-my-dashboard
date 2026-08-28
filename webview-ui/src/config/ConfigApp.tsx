import type { ConfigInitPayload, ExtToWebview, PresetRow } from "@shared/protocol";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SECTIONS, VARIANT_ORDER } from "../constants";
import { countConfigured, groupModelsByProvider, isKnownVariant, mergeRows, type ModelOption } from "../helpers";
import { postToHost } from "../vscode";
import { groupSkillsByLocation, skillDescriptionLabel, skillScopeLabel, upsertRow, type SkillGroup } from "./helpers";

/**
 * Pre-init (and dev-preview) state: the host pushes configInit on boot/navigation,
 * so the tab renders clean empty sections until the first payload lands — no fake
 * data, and nothing is posted on mount.
 */
const EMPTY_PAYLOAD: ConfigInitPayload = {
  rows: [],
  models: [],
  skills: [],
  target: { kind: "omo", path: "" },
};

function rowKey(section: PresetRow["section"], name: string): string {
  return `${section}:${name}`;
}

const ConfigRow = memo(function ConfigRow({
  row,
  groups,
  modelIds,
  pending,
  onChange,
}: {
  row: PresetRow;
  groups: Map<string, ModelOption[]>;
  modelIds: ReadonlySet<string>;
  pending: boolean;
  onChange: (row: PresetRow, patch: { model: string; variant: string | null }) => void;
}) {
  return (
    <div className={row.model ? "row" : "row unset"}>
      <span className="row-name" title={row.name}>
        {row.name}
      </span>
      <select
        className="ctl sel-model"
        value={row.model ?? ""}
        disabled={pending}
        aria-label={`${row.name} 模型`}
        onChange={(e) => {
          const model = e.target.value;
          // The （未设置） placeholder of an unset row is disabled — only real options reach here.
          if (model === "" || model === row.model) {
            return;
          }
          onChange(row, { model, variant: row.variant });
        }}
      >
        {row.model === null && (
          <option value="" disabled>
            （未设置）
          </option>
        )}
        {[...groups].map(([provider, opts]) => (
          <optgroup key={provider} label={provider}>
            {opts.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.id})
              </option>
            ))}
          </optgroup>
        ))}
        {/* A configured model missing from the catalog stays visible/switchable. */}
        {row.model !== null && !modelIds.has(row.model) && <option value={row.model}>{row.model}</option>}
      </select>
      <select
        className="ctl sel-variant"
        value={row.variant ?? ""}
        disabled={pending || row.model === null}
        aria-label={`${row.name} variant`}
        onChange={(e) => {
          // configSetModel requires a non-null model — variant follows the current model.
          if (row.model === null) {
            return;
          }
          onChange(row, { model: row.model, variant: e.target.value === "" ? null : e.target.value });
        }}
      >
        <option value="">不设置</option>
        {VARIANT_ORDER.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
        {row.variant !== null && !isKnownVariant(row.variant) && <option value={row.variant}>{row.variant}</option>}
      </select>
    </div>
  );
});

/** Compact equivalent of the preset editor's SectionBlock (collapsible, 已设置 n/total badge). */
function ModelSection({
  meta,
  rows,
  groups,
  modelIds,
  collapsed,
  pending,
  onToggle,
  onChange,
}: {
  meta: (typeof SECTIONS)[number];
  rows: PresetRow[];
  groups: Map<string, ModelOption[]>;
  modelIds: ReadonlySet<string>;
  collapsed: boolean;
  pending: ReadonlySet<string>;
  onToggle: () => void;
  onChange: (row: PresetRow, patch: { model: string; variant: string | null }) => void;
}) {
  return (
    <section className="block">
      <button type="button" className="block-head" onClick={onToggle} aria-expanded={!collapsed}>
        <span className={`chev${collapsed ? "" : " open"}`} aria-hidden="true">
          ▸
        </span>
        <span className="block-title">
          {meta.icon}&ensp;{meta.title}
        </span>
        <span className="block-count">
          {countConfigured(rows)}/{rows.length} 已设置
        </span>
      </button>
      {!collapsed && (
        <div className="block-body">
          {rows.length === 0 ? (
            <div className="empty">暂无条目</div>
          ) : (
            rows.map((r) => (
              <ConfigRow
                key={rowKey(r.section, r.name)}
                row={r}
                groups={groups}
                modelIds={modelIds}
                pending={pending.has(rowKey(r.section, r.name))}
                onChange={onChange}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

/** One read-only skills location group (collapsible; the list itself has no controls). */
function SkillLocationGroup({
  group,
  collapsed,
  onToggle,
}: {
  group: SkillGroup;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="block">
      <button type="button" className="block-head" onClick={onToggle} aria-expanded={!collapsed}>
        <span className={`chev${collapsed ? "" : " open"}`} aria-hidden="true">
          ▸
        </span>
        <span className="block-title skill-group-title" title={group.locationLabel}>
          {group.locationLabel}
        </span>
        <span className="scope-pill">{skillScopeLabel(group.scope)}</span>
        <span className="block-count">{group.skills.length} 项</span>
      </button>
      {!collapsed && (
        <ul className="block-body skill-list">
          {group.skills.map((skill) => (
            <li className="skill-row" key={skill.name}>
              <span className="skill-name" title={skill.name}>
                {skill.name}
              </span>
              <span className="skill-desc">{skillDescriptionLabel(skill.description)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 配置 tab: the live OMO model assignments (editable, one configSetModel post per
 * row change, optimistic with revert on a !ok reply) plus the read-only skills
 * list. State comes from configInit pushes only — the tab never requests data.
 */
export default function ConfigApp() {
  const [payload, setPayload] = useState<ConfigInitPayload>(EMPTY_PAYLOAD);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Pre-edit values of rows with an in-flight save — the revert source on a !ok reply.
  const preEditRef = useRef(new Map<string, { model: string | null; variant: string | null }>());

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as ExtToWebview | undefined;
      if (!msg || typeof msg !== "object") {
        return;
      }
      if (msg.type === "configInit") {
        // Full replace: the pushed payload is the source of truth and supersedes
        // any in-flight optimistic edit (its own configModelSaved settles the row).
        setPayload(msg.payload);
        preEditRef.current.clear();
        setPending(new Set());
        setError(null);
      } else if (msg.type === "configModelSaved") {
        const { ok, section, name } = msg.payload;
        const key = rowKey(section, name);
        const prev = preEditRef.current.get(key);
        preEditRef.current.delete(key);
        setPending((current) => {
          if (!current.has(key)) {
            return current;
          }
          const next = new Set(current);
          next.delete(key);
          return next;
        });
        if (!ok) {
          if (prev) {
            setPayload((current) => ({ ...current, rows: upsertRow(current.rows, section, name, prev) }));
          }
          setError(msg.payload.error ?? "保存失败，请重试");
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Stale-reply guard (mirror of the preset editor's awaitingResult timeout): a lost
  // host reply must not leave a row's selects disabled forever.
  useEffect(() => {
    if (pending.size === 0) {
      return;
    }
    const t = window.setTimeout(() => {
      preEditRef.current.clear();
      setPending(new Set());
      setError("保存无响应，请重试");
    }, 12_000);
    return () => window.clearTimeout(t);
  }, [pending]);

  /** Optimistically apply a row edit and post it; at most one in-flight save per row. */
  const changeRow = useCallback((row: PresetRow, patch: { model: string; variant: string | null }) => {
    const key = rowKey(row.section, row.name);
    if (preEditRef.current.has(key)) {
      return;
    }
    preEditRef.current.set(key, { model: row.model, variant: row.variant });
    setPending((current) => new Set(current).add(key));
    setError(null);
    setPayload((current) => ({ ...current, rows: upsertRow(current.rows, row.section, row.name, patch) }));
    postToHost({
      type: "configSetModel",
      payload: { section: row.section, name: row.name, model: patch.model, variant: patch.variant },
    });
  }, []);

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((c) => ({ ...c, [key]: !(c[key] ?? false) }));
  }, []);

  const modelsByProvider = useMemo(() => groupModelsByProvider(payload.models), [payload.models]);
  const modelIds = useMemo(() => new Set(payload.models.map((m) => m.id)), [payload.models]);
  const rowsBySection = useMemo(() => {
    const map = new Map<PresetRow["section"], PresetRow[]>();
    for (const meta of SECTIONS) {
      map.set(meta.key, mergeRows(meta.known, payload.rows, meta.key));
    }
    return map;
  }, [payload.rows]);
  const skillGroups = useMemo(() => groupSkillsByLocation(payload.skills), [payload.skills]);

  const targetLabel = payload.target.kind === "omo" ? "oh-my-openagent" : "legacy";

  return (
    <div className="cfg-tab">
      {error && (
        <div className="banner-error" role="alert">
          <span className="banner-icon" aria-hidden="true">
            ⛔
          </span>
          {error}
        </div>
      )}

      <section className="cfg-block" aria-label="模型配置">
        <header className="cfg-block-head">
          <h2>模型配置</h2>
          <p className="cfg-target">
            写入目标：{targetLabel}
            {payload.target.path !== "" && (
              <code className="cfg-target-path" title={payload.target.path}>
                {payload.target.path}
              </code>
            )}
          </p>
        </header>
        {SECTIONS.map((meta) => (
          <ModelSection
            key={meta.key}
            meta={meta}
            rows={rowsBySection.get(meta.key) ?? []}
            groups={modelsByProvider}
            modelIds={modelIds}
            collapsed={collapsed[meta.key] ?? false}
            pending={pending}
            onToggle={() => toggleCollapsed(meta.key)}
            onChange={changeRow}
          />
        ))}
      </section>

      {/* Read-only by construction: the skills list renders no interactive elements.
          (aria-readonly is NOT set — it is invalid ARIA on non-widget containers.) */}
      <section className="cfg-block" aria-label="Skills">
        <header className="cfg-block-head">
          <h2>Skills</h2>
        </header>
        {skillGroups.length === 0 ? (
          <div className="empty">未发现 Skills</div>
        ) : (
          skillGroups.map((group) => (
            <SkillLocationGroup
              key={group.locationLabel}
              group={group}
              collapsed={collapsed[`skills:${group.locationLabel}`] ?? false}
              onToggle={() => toggleCollapsed(`skills:${group.locationLabel}`)}
            />
          ))
        )}
      </section>
    </div>
  );
}
