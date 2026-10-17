# 更新记录

## 1.3.2

- 验证适配 DeepSeek Harness 0.2.1-rc.2 的侧边嵌入界面、设置保存、只读工具限制和关闭清理。
- 修复局域网 HTTP 页面缺少 `crypto.randomUUID` 时无法创建临时会话的问题。
- 包介绍默认使用中文，并添加宿主支持的中英文插件展示信息。
- 更新宿主界面类型依赖和兼容性检查，补充新版工具拒绝与 HTTP 会话测试。

## 1.3.1

- Fixed settings integration with schema-derived Harness configuration forms.
- Exported a native live Config schema and addressed settings by the owning profile entry.
- Restored the settings page, with revision-guarded saves and persistent live updates.
- Preserved configured profile values when the optional settings service is unavailable.

## 1.3.0

- Unified repository, package, plugin identifiers, API routes, and documentation under `dsh-sidechat` / Sidechat.
- Migrated browser history metadata and recovery of earlier temporary-session records.
- Updated installation archives and local profile configuration.

## 1.2.2

- Published ready-to-install archives and Chinese/English product documentation.

## 1.2.1

- Added read-only file reading, listing, and literal search.
- Enforced tool execution restrictions and read-only file policy.

## 1.2.0

- Introduced temporary side conversations with native Harness controls and tab-close cleanup.
