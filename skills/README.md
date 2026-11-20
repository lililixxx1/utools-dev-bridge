# skills/ — 配套 AI 技能（公开分发版）

dev-bridge 工作流的两个配套 AI 技能，脱敏后随本仓库公开分发：

| 技能 | 用途 |
| --- | --- |
| `utools-dev-bridge/` | 桥的驾驶手册：13 个 `dev_*` 工具（沙箱加载 / `dev_run` 批量断言 / `dev_job` 异步 / `dev_ui_*` 真窗口调试 / `dev_cleanup` 还原）与错误码速查 |
| `utools-plugin-dev/` | uTools 插件开发知识库：26 章官方 API 参考（对齐 uTools 8.0.2）+ 硬约束（uTools 现也提供官方 [Plugin Dev Skill](https://www.u-tools.cn/docs/ai/plugin-dev-skill.html)） |

## 安装

将技能目录（包含 `SKILL.md` 与 `references/`，目录名必须与 `SKILL.md` 中的 `name` 一致）复制到你所用 AI 客户端的技能目录：

| 客户端 | 项目级目录 | 个人级目录 |
| --- | --- | --- |
| VS Code + GitHub Copilot | `.github/skills/` | `~/.copilot/skills/` |
| Cursor / 通用 Agent | `.cursor/skills/`（或 `.agents/skills/`） | `~/.cursor/skills/`（或 `~/.agents/skills/`） |
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |

```bash
# clone 本仓库后，复制到对应客户端技能目录，例如：
cp -r skills/utools-dev-bridge skills/utools-plugin-dev ~/.agents/skills/
```

纯静态 Markdown，无脚本无依赖；更新时重新复制覆盖。

## 公开版口径

- 本目录是**公开分发版**；`utools-plugin-dev` 公开版不含非公开 builder 规范与内部文档同步管线脚本。
- `utools-dev-bridge` 技能与本仓库 `README.md` / `preload/contract.js` 冲突时，以 `preload/contract.js` 和 `README.md` 为准。
