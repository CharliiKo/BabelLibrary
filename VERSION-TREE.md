# 版本树（VERSION-TREE）

kb-studio 的版本演进线。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)，以 git **标签**为准（`git tag -l`）。

## 演进图

```
main ──● v1.0.0 ──● v1.1.0 ──● v1.1.1 (HEAD)
        8dc1356     e413a58     <见 git tag>
        2026-10-20  2026-10-20  2026-10-20
```

## 版本谱系

| 标签 | 主题 | 维护方 | 血统 / 来源 | 摘要 |
|---|---|---|---|---|
| **v1.0.0** (`8dc1356`) | Aurora UI 重设计与稳定性 | DeepSeek 端 | 项目基线首版：百炼「ParseX + RAG + 问答」三段式原型 + 全新视觉/动效/无障碍体系 | 设计 token（浅/深主题）、玻璃面板、极光背景、21 组动效、键盘全量可达、产物下载契约修复 |
| **v1.1.0** (`e413a58`) | AI Platform 多协议兼容 | Gemini4-Argon | 基于 v1.0.0；代码自 `kb-studio.zip` **原样入库**（SHA-256 `F9FCDED1…BEEBC`），共 7 文件 +2471/−245，零行为修改 | 三大协议出站适配（Responses/Chat Completions/Anthropic + auto 回退）、对外 `/v1/*` 兼容端点、`/api/settings` 运行时配置、配置 UI、OpenAI 兼容向量化 |
| **v1.1.1** (HEAD) | 发布工程 | DeepSeek 端 | 基于 v1.1.0 的**补丁版本**，不改变功能行为 | 补齐 README 声称的离线自测套件（12/12）、`VERSION` 文件驱动版本号、README 安全说明恢复、空 API Key 不再遮蔽环境变量、CHANGELOG / 版本树文档 |

## 血统说明

- **v1.1.0 完整继承 v1.0.0**：Aurora 视觉、无障碍修复（键盘可达 / 焦点陷阱 / 对比度）、产物下载按钮修复全部保留（复验见 `.ui-preview/reviews/v110-ui.md`）。
- v1.1.0 与 v1.1.1 的差异仅为发布工程（自测文件、版本对齐、README、一处 `lib/llm.js` 空值修复），功能代码与 v1.1.0 交付版一致。
- v1.1.0 的已知问题（`/v1/*` 无鉴权 + CORS `*`、无效 index 回落、model_not_found 误判回退等）逐条记录于 [CHANGELOG.md](CHANGELOG.md) 的 v1.1.0「已知问题」小节。

## 常用命令

```bash
git tag -l                                  # 查看全部版本
git log --oneline --decorate --graph        # 查看带标签的演进线
git show v1.1.0 --stat                      # 查看某版本相对上一版的变更
git diff v1.0.0 v1.1.0 --stat               # 任意两版差异
node test/api-compatibility.test.js         # 当前工作区离线自测（模拟模式）
```

## 各版本验证证据（`.ui-preview/reviews/`，不入库）

| 版本 | 报告 |
|---|---|
| v1.0.0 | `a11y-consistency.md`（两轮：审计 + 修复复验）、`runtime.md`（两轮：矩阵 + 下载修复复验） |
| v1.1.0 | `v110-protocol.md`（协议矩阵 35/38，桩上游实测）、`v110-ui.md`（UI 回归全过） |
| v1.1.1 | `node test/api-compatibility.test.js` 输出（12/12） |
