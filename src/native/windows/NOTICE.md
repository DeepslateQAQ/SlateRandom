# Windows 权限组件

`SlateRandom.Privileges.cs`、清单、Node 服务和构建脚本采用项目 [GNU GPL 第 3 版或更新版本（GPL-3.0-or-later）许可证](../../../LICENSE)。

功能参考为 [HelloWRC/GrantUiAccess](https://github.com/HelloWRC/GrantUiAccess)，采用 GPL-3.0。本组件为独立 Win32 API 实现，本工程没有复制或分发该参考项目的源码及二进制。

本组件调用 Windows 自带的 `kernel32.dll`、`advapi32.dll` 和 `shell32.dll`，使用 .NET Framework 的标准库。微软的 API 名称、结构字段和平台行为以 Microsoft Learn 文档为准；详细参考与限制见 [PRIVILEGES.md](../../../docs/PRIVILEGES.md)。

构建后的 `SlateRandom.Privileges.exe` 不包含第三方 UIAccess 核心。完整对应源代码随 SlateRandom 源码一同提供。
