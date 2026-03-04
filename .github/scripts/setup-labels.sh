#!/bin/bash
# AutoMater — GitHub Labels 批量创建脚本
# 使用: GITHUB_TOKEN=xxx bash .github/scripts/setup-labels.sh
# 或在 PowerShell 中: 见下方 PowerShell 版本

OWNER="${GITHUB_OWNER:-your-org}"
REPO="${GITHUB_REPO:-AutoMater}"

# ============ 类型标签 ============
declare -A TYPE_LABELS=(
  ["bug"]="d73a4a:Something isn't working"
  ["enhancement"]="a2eeef:New feature or request"
  ["testing"]="0e8a16:Test execution and verification"
  ["verification"]="0e8a16:Test verification report"
  ["documentation"]="0075ca:Improvements or additions to documentation"
  ["refactor"]="fbca04:Code refactoring"
  ["performance"]="f9d0c4:Performance improvement"
  ["experience"]="c5def5:User experience improvement"
)

# ============ 优先级标签 ============
declare -A PRIORITY_LABELS=(
  ["P0-critical"]="b60205:阻断性 — 应用崩溃/数据丢失/核心流程中断"
  ["P1-important"]="d93f0b:严重 — 主要功能不可用"
  ["P2-minor"]="0e8a16:一般 — 次要功能异常"
  ["P3-trivial"]="c2e0c6:轻微 — 美化/优化"
)

# ============ 状态标签 ============
declare -A STATUS_LABELS=(
  ["needs-triage"]="e4e669:Needs review and classification"
  ["confirmed"]="1d76db:Bug confirmed and reproducible"
  ["in-progress"]="5319e7:Being actively worked on"
  ["needs-retest"]="fbca04:Fix deployed, needs verification"
  ["verified"]="0e8a16:Fix verified, ready to close"
  ["blocked"]="d73a4a:Blocked by dependency"
  ["duplicate"]="cfd3d7:Duplicate issue"
  ["wontfix"]="ffffff:Will not be fixed"
)

# ============ 模块标签 ============
declare -A MODULE_LABELS=(
  ["mod:app"]="c5def5:应用启动与基础设施"
  ["mod:settings"]="c5def5:设置与配置"
  ["mod:project"]="c5def5:项目管理"
  ["mod:import"]="c5def5:项目导入"
  ["mod:wish"]="c5def5:许愿与需求"
  ["mod:pipeline"]="c5def5:流水线编排"
  ["mod:developer"]="c5def5:Developer ReAct循环"
  ["mod:qa"]="c5def5:QA审查"
  ["mod:nav"]="c5def5:导航与布局"
  ["mod:overview"]="c5def5:全景仪表盘"
  ["mod:board"]="c5def5:看板视图"
  ["mod:docs"]="c5def5:文档管理"
  ["mod:output"]="c5def5:代码产出"
  ["mod:logs"]="c5def5:日志系统"
  ["mod:workflow"]="c5def5:工作流预设"
  ["mod:team"]="c5def5:团队管理"
  ["mod:meta-agent"]="c5def5:元Agent"
  ["mod:mission"]="c5def5:临时工作流"
  ["mod:context"]="c5def5:上下文管理"
  ["mod:timeline"]="c5def5:时间线与分析"
  ["mod:git"]="c5def5:Git集成"
  ["mod:llm"]="c5def5:LLM调用层"
  ["mod:sandbox"]="c5def5:沙箱执行"
  ["mod:memory"]="c5def5:持久记忆"
  ["mod:skill"]="c5def5:技能系统"
  ["mod:mcp"]="c5def5:MCP协议"
  ["mod:guide"]="c5def5:新手教程"
  ["mod:session"]="c5def5:会话管理"
  ["mod:monitor"]="c5def5:系统监控"
  ["mod:error"]="c5def5:错误处理与韧性"
)

# ============ 验收标签 ============
declare -A TEST_LABELS=(
  ["test-pass"]="0e8a16:All test cases passed"
  ["test-fail"]="d73a4a:Test verification failed"
  ["test-partial"]="fbca04:Partial pass — some issues found"
)

# ============ Sprint 标签 ============
declare -A SPRINT_LABELS=(
  ["round-1"]="bfdadc:R1 冒烟测试"
  ["round-2"]="bfdadc:R2 核心流程"
  ["round-3"]="bfdadc:R3 辅助功能"
  ["round-4"]="bfdadc:R4 浏览与展示"
  ["round-5"]="bfdadc:R5 韧性与边界"
  ["round-6"]="bfdadc:R6 体验打磨"
)

# ============ 创建函数 ============
create_label() {
  local name="$1"
  local color="${2%%:*}"
  local desc="${2#*:}"
  
  echo "Creating label: $name ($color) — $desc"
  gh label create "$name" --color "$color" --description "$desc" --repo "$OWNER/$REPO" 2>/dev/null || \
  gh label edit "$name" --color "$color" --description "$desc" --repo "$OWNER/$REPO" 2>/dev/null
}

# ============ 执行 ============
echo "=== Creating Type Labels ==="
for label in "${!TYPE_LABELS[@]}"; do create_label "$label" "${TYPE_LABELS[$label]}"; done

echo "=== Creating Priority Labels ==="
for label in "${!PRIORITY_LABELS[@]}"; do create_label "$label" "${PRIORITY_LABELS[$label]}"; done

echo "=== Creating Status Labels ==="
for label in "${!STATUS_LABELS[@]}"; do create_label "$label" "${STATUS_LABELS[$label]}"; done

echo "=== Creating Module Labels ==="
for label in "${!MODULE_LABELS[@]}"; do create_label "$label" "${MODULE_LABELS[$label]}"; done

echo "=== Creating Test Labels ==="
for label in "${!TEST_LABELS[@]}"; do create_label "$label" "${TEST_LABELS[$label]}"; done

echo "=== Creating Sprint Labels ==="
for label in "${!SPRINT_LABELS[@]}"; do create_label "$label" "${SPRINT_LABELS[$label]}"; done

echo ""
echo "✅ All labels created/updated!"
echo ""

# ============ 创建里程碑 ============
echo "=== Creating Milestones ==="
gh api repos/$OWNER/$REPO/milestones -f title="v6.0-smoke" -f description="R1冒烟测试 — 全P0通过" 2>/dev/null || echo "Milestone v6.0-smoke already exists"
gh api repos/$OWNER/$REPO/milestones -f title="v6.0-pipeline" -f description="R2核心流程 — P0全通过 + P1≥80%" 2>/dev/null || echo "Milestone v6.0-pipeline already exists"
gh api repos/$OWNER/$REPO/milestones -f title="v6.0-beta" -f description="R1-R5所有P0归零 + P1≥85%" 2>/dev/null || echo "Milestone v6.0-beta already exists"
gh api repos/$OWNER/$REPO/milestones -f title="v6.0-release" -f description="全部TC≥95%通过" 2>/dev/null || echo "Milestone v6.0-release already exists"

echo ""
echo "✅ All milestones created!"
