/**
 * Canonical error-message authority (vscode-free, pure — bundleable from core and webview host
 * glue alike). Core layers throw SCREAMING_SNAKE error codes (or NodeJS errno exceptions, or
 * JsoncSyntaxError); this module is the single place that turns them into user-facing Chinese.
 *
 * `errorMessage` is total: it never throws and always returns a string.
 */

/**
 * Error-code → Chinese message table. Keys are exact `error.message` matches for coded Errors
 * thrown by core layers (e.g. `throw new Error("CONFIG_UNREADABLE")`).
 */
export const FRIENDLY_ERRORS: Record<string, string> = {
  INVALID_PRESET_NAME: "模板名称不合法",
  PRESET_NOT_FOUND: "模板不存在",
  PRESET_INVALID: "模板文件已损坏（JSON 解析失败）",
  PRESET_ALREADY_EXISTS: "同名模板已存在",
  INVALID_BACKUP_NAME: "备份名称不合法",
  BACKUP_NOT_FOUND: "备份不存在",
  BACKUP_PUBLISH_FAILED: "备份发布失败（manifest 缺失）",
  BACKUP_IMPORT_INVALID: "备份压缩包无效或已损坏",
  BACKUP_EXPORT_TOO_LARGE: "备份内容过大（超过 256MB 或 2 万条目上限），无法导出",
  BACKUP_CREATE_TOO_LARGE: "备份内容过大（超过 256MB、2 万条目或 16 层目录上限），已中止备份",
  BACKUP_RESTORE_TOO_LARGE: "备份内容过大（超过 256MB 或 2 万条目上限），已中止恢复",
  CONFIG_UNREADABLE: "配置文件存在但无法读取（权限或被占用），已中止以防覆盖",
  OPENCODE_SETTING_INVALID: "OpenCode 设置项的键或值不合法",
  OPENCODE_SETTING_CONFLICT: "配置文件中同名键的类型与写入冲突，请先修正该键或改用文件编辑",
  OMO_SETTING_INVALID: "OMO 功能设置的键或值不合法",
  TUI_THEME_INVALID: "TUI 主题名不合法",
  MIMO_COOKIE_INVALID: "MiMo Cookie 格式无法识别，请粘贴完整的 Cookie 字符串",
  FREE_PORT_UNAVAILABLE: "无法获取可用的随机端口，请稍后重试",
  TMUX_NOT_FOUND: "未检测到 tmux，请先安装后重试（Debian/Ubuntu: apt install tmux，macOS: brew install tmux）",
  TMUX_NOT_FOUND_WINDOWS:
    "Windows 原生不支持 tmux——请用 Remote-WSL 打开工作区，并在 WSL 内安装 tmux（sudo apt install tmux）后重试",
};

/** Map a NodeJS errno code to a Chinese, action-oriented message. */
function errnoMessage(code: string): string {
  switch (code) {
    case "EACCES":
    case "EPERM":
      return `没有权限访问文件或目录（${code}）`;
    case "EBUSY":
      return "文件被其他程序占用（EBUSY）";
    case "ENOSPC":
      return "磁盘空间不足（ENOSPC）";
    case "ENOENT":
      return "文件不存在（ENOENT）";
    case "ENAMETOOLONG":
      return "文件名过长（ENAMETOOLONG）";
    default:
      return `文件系统操作失败（${code}）`;
  }
}

/** True for jsoncEditor's JsoncSyntaxError or any Error carrying a jsonc-parser errors array. */
function isJsoncSyntaxError(error: Error): boolean {
  return error.name === "JsoncSyntaxError" || Array.isArray((error as { errors?: unknown }).errors);
}

/** Count of JSONC syntax problems: attached errors array first, then the message, else 1. */
function jsoncErrorCount(error: Error): number {
  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.length;
  }
  const match = /JSONC syntax errors:\s*(\d+)/.exec(error.message);
  return match !== null ? Number(match[1]) : 1;
}

/**
 * Convert any thrown value into a user-facing Chinese string. Resolution order:
 * 1. exact `error.message` match in {@link FRIENDLY_ERRORS};
 * 2. JsoncSyntaxError shape → "配置文件存在 JSONC 语法错误（N 处）…";
 * 3. NodeJS errno `code` → permission/occupancy/space/existence/length message;
 * 4. fallback: `Error.message`, otherwise `String(error)`.
 * Total function — never throws.
 */
export function errorMessage(error: unknown): string {
  try {
    const raw = error instanceof Error ? error.message : String(error);
    const coded = FRIENDLY_ERRORS[raw];
    if (coded !== undefined) {
      return coded;
    }
    if (error instanceof Error) {
      if (isJsoncSyntaxError(error)) {
        return `配置文件存在 JSONC 语法错误（${jsoncErrorCount(error)} 处），请先修复后再试`;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (typeof code === "string") {
        return errnoMessage(code);
      }
      return error.message;
    }
    return raw;
  } catch {
    // Defensive only: the paths above cannot throw for well-behaved inputs.
    return String(error);
  }
}

/**
 * Log-oriented variant of {@link errorMessage}: the friendly Chinese message plus the
 * raw original detail (errno message with the failing path, the raw error code), so
 * output-channel logs stay diagnostic. User-visible surfaces (show*Message, webview
 * replies) must keep using errorMessage — never leak raw details there. Total function.
 */
export function errorDetail(error: unknown): string {
  try {
    const friendly = errorMessage(error);
    const raw = error instanceof Error ? error.message : String(error);
    return raw === friendly ? friendly : `${friendly}（原始信息: ${raw}）`;
  } catch {
    return String(error);
  }
}
