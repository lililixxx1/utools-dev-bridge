# skills/ — 配套 AI 技能（公开分发版）

dev-bridge 工作流的两个配套 AI 技能，脱敏后随本仓库公开分发：

| 技能 | 用途 |
| --- | --- |
| `utools-dev-bridge/` | 桥的驾驶手册：dev_load / dev_call / dev_console / dev_calls_log / dev_cleanup 标准测试循环、实机坑、错误码速查 |
| `utools-plugin-dev/` | uTools 插件开发知识库：26 章官方 API 参考（对齐 uTools 8.0.2）+ 硬约束 |

## 安装

技能目录路径因 agent 客户端而异（ZCode/通用 agents 用 `~/.agents/skills/`，Claude Code、Codex 等按各自约定），装进**你所用客户端的技能目录**即可。以 ZCode 为例：

```bash
# clone 本仓库后,复制到本机技能目录
cp -r skills/utools-dev-bridge skills/utools-plugin-dev ~/.agents/skills/
```

纯静态 Markdown,无脚本无依赖;更新时重新复制覆盖。

## 公开版口径

- 本目录是**分发快照**,维护者的日常维护源在其本机技能目录(utools-plugin-dev 的 references/ 由官方文档清洗管线同步),两边可能存在少量时差。
- `utools-plugin-dev` 公开版**不含** `references/builder/`(官方 AI 生成插件规范镜像)与文档同步脚本——内容来源为官方非公开渠道,不随公开仓库分发。
- `utools-dev-bridge` 技能与本仓库 `README.md` 冲突时,以 `README.md` 为准(技能是日常驾驶手册,README 是权威文档)。
