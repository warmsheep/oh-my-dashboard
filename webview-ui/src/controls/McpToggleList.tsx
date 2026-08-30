/**
 * mcpServers-kind editor: one row per declared server (name + 停用 switch). Writes
 * are per-key single-entry snapshot maps ({ name: disabled }) — the host diffs them
 * (true → set mcp.<name>.enabled=false, false → remove the enabled override) and
 * never wipes the mcp key. No 打开配置文件 button this wave: the servers themselves
 * are declared in opencode.json, so the list carries the config path as a title
 * attribute plus a hint pointing at the 配置文件 tree node.
 */
export default function McpToggleList({
  servers,
  configPath,
  disabled,
  onToggle,
}: {
  /** Declared servers from the tab payload (readMcpServers). */
  servers: { name: string; disabled: boolean }[];
  /** opencode.json path (title attribute of the list). */
  configPath: string;
  /** Pending-write disable shared with the hosting set-row. */
  disabled: boolean;
  /** Commit one server's next disabled flag (single-key snapshot semantics). */
  onToggle(name: string, nextDisabled: boolean): void;
}) {
  return (
    <div className="ctl-list ctl-mcp" title={configPath}>
      {servers.length === 0 ? (
        <span className="set-row-hint">未声明 MCP 服务器</span>
      ) : (
        servers.map((server) => (
          <div className="ctl-row" key={server.name}>
            <span className="ctl-text ctl-mono" title={server.name}>
              {server.name}
            </span>
            <span className="set-row-hint">停用</span>
            <label className="s-switch">
              <input
                type="checkbox"
                className="s-switch-input"
                aria-label={`停用服务器 ${server.name}`}
                checked={server.disabled}
                disabled={disabled}
                onChange={() => onToggle(server.name, !server.disabled)}
              />
              <span className="s-switch-track" aria-hidden="true" />
            </label>
          </div>
        ))
      )}
      <span className="set-row-hint">服务器的增删请在「配置文件」分区打开 opencode.json 编辑</span>
    </div>
  );
}
