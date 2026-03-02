# 智械母机 AutoMater — 测试工作流操作手册

> **版本**: v1.0 | **日期**: 2026-03-02  
> **仓库**: `audiomagician1-ai/AgentForge`

---

## 一、工作流总览

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  准备环境    │───→│  执行测试    │───→│  记录结果    │───→│  跟踪修复    │
│  (一次性)    │    │  (按轮次)    │    │  (Issue)     │    │  (看板)      │
└─────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

---

## 二、环境准备（一次性）

### 2.1 初始化标签体系

**PowerShell 方式（推荐）**：

```powershell
# 获取 GitHub 凭据
$token = (echo "protocol=https`nhost=github.com`n" | git credential fill | Select-String "password" | % { ($_ -split "=",2)[1] })
$headers = @{ "Authorization"="Bearer $token"; "Accept"="application/vnd.github+json" }
$base = "https://api.github.com/repos/audiomagician1-ai/AgentForge"

# 创建标签函数
function New-GitHubLabel($name, $color, $desc) {
    $body = @{ name=$name; color=$color; description=$desc } | ConvertTo-Json
    try {
        Invoke-RestMethod -Uri "$base/labels" -Method Post -Headers $headers -Body $body -ContentType "application/json"
        Write-Host "✅ Created: $name" -ForegroundColor Green
    } catch {
        if ($_.Exception.Response.StatusCode -eq 422) {
            Invoke-RestMethod -Uri "$base/labels/$name" -Method Patch -Headers $headers -Body $body -ContentType "application/json"
            Write-Host "🔄 Updated: $name" -ForegroundColor Yellow
        }
    }
}

# 批量执行（参见 .github/scripts/setup-labels.sh 中的完整列表）
# 类型标签
New-GitHubLabel "bug" "d73a4a" "Something isn't working"
New-GitHubLabel "enhancement" "a2eeef" "New feature or request"
New-GitHubLabel "testing" "0e8a16" "Test execution and verification"
# ... 更多标签见 setup-labels.sh
```

**gh CLI 方式**：

```bash
bash .github/scripts/setup-labels.sh
```

### 2.2 创建里程碑

```powershell
# 里程碑
$milestones = @(
    @{title="v6.0-smoke"; description="R1冒烟测试 — 全P0通过"},
    @{title="v6.0-pipeline"; description="R2核心流程 — P0全通过 + P1≥80%"},
    @{title="v6.0-beta"; description="R1-R5所有P0归零 + P1≥85%"},
    @{title="v6.0-release"; description="全部TC≥95%通过"}
)

foreach ($m in $milestones) {
    $body = $m | ConvertTo-Json
    Invoke-RestMethod -Uri "$base/milestones" -Method Post -Headers $headers -Body $body -ContentType "application/json"
}
```

### 2.3 构建与启动

```powershell
cd D:\EchoAgent\projects\AgentForge
pnpm install
pnpm test                 # 确认71个单元测试通过
pnpm run dev              # 开发模式启动
# 或
pnpm run build            # 构建
pnpm run preview          # 预览
```

---

## 三、测试执行流程

### 3.1 按轮次执行

| Round | 模块 | 前置条件 |
|-------|------|---------|
| R1 | APP + SET + PRJ | 应用能启动 |
| R2 | WSH + PIP + DEV + QA + LLM | R1 通过 + 有效LLM Key |
| R3 | IMP + META + WKF + TEM | R1 通过 + 有效LLM Key |
| R4 | NAV + OVW + BRD + DOC + OUT + LOG | R1 通过 |
| R5 | ERR + SBX + GIT + MEM + SES + CTX + TML | R1+R2 通过 |
| R6 | GDE + MON + 回归 | R1-R5 通过 |

### 3.2 单个 TC 执行步骤

1. **打开** `docs/testing/BLACKBOX_TEST_PLAN.md` 找到当前模块的 TC 表
2. **准备** 前置条件
3. **执行** 操作步骤
4. **对比** 预期结果与实际结果
5. **记录** 结果到结果表：
   - ✅ — 完全符合预期
   - ❌ — 不符合预期（必须创建 Bug Issue）
   - ⚠️ — 基本通过但有小问题（酌情创建 Bug）
   - ⏭️ — 由于环境/前置条件跳过

### 3.3 每轮结束后

1. 创建 **验收报告 Issue**：`[Test] TC-{模块} — 2026-03-XX`
2. 使用 `test_verification.yml` 模板
3. 填写结果表 + 关联 Bug + 总结评估
4. 打标签：`test-pass` / `test-fail` / `test-partial`

---

## 四、Bug Issue 管理

### 4.1 创建 Bug Issue

使用 `bug_report.yml` 模板，填写：
- **模块**: 从下拉选择
- **严重程度**: P0~P3
- **复现步骤**: 尽量详细，附截图
- **关联 TC**: 填写发现该 Bug 的 TC 编号

### 4.2 Bug 状态流转

```
needs-triage → confirmed → in-progress → needs-retest → verified → [CLOSED]
                    ↘ duplicate/wontfix → [CLOSED]         ↘ 复测失败 → in-progress
```

| 当前状态 | 动作 | 下一状态 | 操作人 |
|---------|------|---------|--------|
| needs-triage | 确认可复现 | confirmed + P级 + mod:标签 | 开发 |
| confirmed | 开始修复 | in-progress + Assign | 开发 |
| in-progress | push fix commit | needs-retest（评论commit hash） | 开发 |
| needs-retest | 复测通过 | verified → Close | 测试 |
| needs-retest | 复测失败 | in-progress（重开+评论原因） | 测试 |

### 4.3 Bug Fix Commit 规范

```
fix(<模块>): <描述> (fixes #N)

例:
fix(pipeline): 修复并发启动双重orchestrator (fixes #12)
fix(settings): 防止空API Key保存 (fixes #15)
```

---

## 五、仪表盘快捷查询

| 视图 | GitHub URL 筛选 |
|------|-----------------|
| 全部待分类 | `is:open label:needs-triage` |
| P0 紧急 | `is:open label:P0-critical` |
| 某模块全部 | `is:open label:mod:pipeline` |
| 待复测 | `is:open label:needs-retest` |
| 验收报告 | `label:verification` |
| 当前轮次 | `is:open label:round-1` |
| 已验证可关闭 | `is:open label:verified` |

**快速链接**: `https://github.com/audiomagician1-ai/AgentForge/issues?q=is:open+label:{标签名}`

---

## 六、验收标准

### 里程碑门槛

| Milestone | 条件 | 需满足 |
|-----------|------|--------|
| v6.0-smoke | R1 | 全P0通过 |
| v6.0-pipeline | R1+R2 | P0全通过，P1≥80% |
| v6.0-beta | R1-R5 | 所有P0归零，P1≥85% |
| v6.0-release | R1-R6 | 全部TC≥95%通过 |

### 通过/不通过判定

- **轮次通过**: 该轮所有 P0 用例通过 + P1 通过率达标
- **整体通过**: 所有轮次通过 + 无 open P0/P1 Bug
- **阻塞**: 任何 P0 用例失败 → 本轮阻塞，优先修复后重测

---

## 七、测试数据管理

### 预置测试数据

| 数据 | 内容 | 存放 |
|------|------|------|
| 简单Wish | "做一个待办事项应用，支持添加、删除、标记完成" | 手动输入 |
| 复杂Wish | 500字详细需求（含技术栈指定） | `docs/testing/test-data/complex-wish.txt` |
| 小型代码仓库 | 10~30文件的Node.js项目 | 任意GitHub public repo |
| 无效API Key | `sk-invalid-test-key-12345` | 手动输入 |
| 无效模型名 | `gpt-nonexistent-model` | 手动输入 |

### 测试结果存档

- 每轮测试的验收报告 Issue 会自动关联到对应里程碑
- Bug Issue 通过 `fixes #N` 自动关联到 commit
- 所有历史可通过 GitHub Issues 页面追溯

---

## 八、补充说明

### 与现有单元测试的关系

| 层次 | 工具 | 覆盖 | 文件 |
|------|------|------|------|
| 单元测试 | vitest | output-parser, guards, llm-client (71 cases) | `electron/engine/__tests__/` |
| 黑盒测试 | 手动 + GitHub Issues | 全应用用户场景 (173 cases) | 本文档 |

两者互补：单元测试验证内部逻辑正确性，黑盒测试验证端到端用户体验。

### 回归测试策略

- 每次 Bug Fix 后，重新执行该 Fix 涉及的 TC（而非全量回归）
- 里程碑门槛检查时，执行全量回归
- 重大架构变更后，从 R1 重新开始

### 常见问题

**Q: 流水线跑到一半LLM Key额度用完怎么办？**
A: 暂停项目 → 更换Key或等额度恢复 → 续跑。这本身也是一个测试场景(TC-ERR-007)。

**Q: 某个TC的前置条件不满足怎么办？**
A: 标记为 ⏭️ 跳过，在验收报告中说明原因，不计入通过率。

**Q: 发现了测试计划中没有的Bug怎么办？**
A: 直接创建 Bug Issue。测试计划外的Bug同样需要跟踪。
