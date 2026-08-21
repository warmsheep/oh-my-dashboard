#!/usr/bin/env bash
# 在 code-server 中安装 OpenCode Config Manager 扩展
# 用法:
#   ./scripts/install-code-server.sh              # 安装 build/packages 下最新的 vsix
#   ./scripts/install-code-server.sh <path.vsix>  # 安装指定 vsix
set -euo pipefail

cd "$(dirname "$0")/.."

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'
info()  { echo -e "${GREEN}[安装]${NC} $*"; }
warn()  { echo -e "${YELLOW}[警告]${NC} $*"; }
fail()  { echo -e "${RED}[错误]${NC} $*" >&2; exit 1; }

VSIX="${1:-}"

if [[ -z "$VSIX" ]]; then
  VSIX=$(ls -t build/packages/*.vsix 2>/dev/null | head -1)
  [[ -n "$VSIX" ]] || fail "build/packages 下没有 .vsix，请先运行 npm run package"
fi
[[ -f "$VSIX" ]] || fail "文件不存在: $VSIX"

CODE_SERVER="${CODE_SERVER:-}"
if [[ -z "$CODE_SERVER" ]]; then
  for candidate in code-server /usr/bin/code-server /usr/local/bin/code-server; do
    if command -v "$candidate" >/dev/null 2>&1; then
      CODE_SERVER="$candidate"
      break
    fi
  done
fi
[[ -n "$CODE_SERVER" ]] || fail "未找到 code-server，可用环境变量 CODE_SERVER 指定其路径"

info "code-server: $("$CODE_SERVER" --version | head -1)"
info "安装: $VSIX"

if ! "$CODE_SERVER" --install-extension "$VSIX" --force; then
  fail "安装失败（code-server 版本过旧时可能不兼容，可尝试更换 vsix 版本）"
fi

INSTALLED=$("$CODE_SERVER" --list-extensions 2>/dev/null | grep -i "opencode-config-manager" || true)
[[ -n "$INSTALLED" ]] || fail "安装命令成功但扩展列表中未找到，请检查 code-server 扩展目录"

info "完成: $INSTALLED"
EXT_DIR="${CS_EXTENSIONS_DIR:-$HOME/.local/share/code-server/extensions}"
echo "扩展目录: $EXT_DIR"
warn "若 code-server 已在运行，请在网页端重新加载窗口（Reload）以激活扩展"
