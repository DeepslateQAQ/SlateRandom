# SlateRandom 岩选第三方组件与许可证

适用版本：SlateRandom 岩选 1.0.0。

项目原创代码 Copyright © 2026 DeepslateQAQ，采用 [GNU GPL 第 3 版或更新版本（GPL-3.0-or-later）](LICENSE)。本文件列出随程序分发或参与构建的第三方组件；项目许可不替代它们各自的版权和许可条款。

## 运行时组件

| 组件 | 版本 | 许可证 | 版权 / 来源 | 保留位置 |
| --- | --- | --- | --- | --- |
| Vue | 3.5.44 | MIT | Copyright © 2018-present Yuxi (Evan) You | 打包进 HTML；`dependencyLicenses` 文本块 |
| Vue 运行时传递依赖 | 见 `pnpm-lock.yaml` | MIT | Vue contributors | 打包进 HTML；`dependencyLicenses` 文本块 |
| Material Color Utilities（HCT/CAM16） | 0.4.0 | Apache-2.0 | Copyright Google LLC | 打包进 HTML；`dependencyLicenses` 文本块与[上游许可](https://github.com/material-foundation/material-color-utilities/blob/main/LICENSE) |
| SheetJS Community Edition | 0.20.3 | Apache-2.0 | Copyright © 2012-present SheetJS LLC | `resources/vendor/xlsx.full.min.js`、[完整许可](resources/vendor/SheetJS-LICENSE.txt)、HTML 的 `sheetjsLicense` 文本块 |
| Google Material Symbols Outlined 字体子集 | 当前子集 | Apache-2.0 | Copyright Google LLC | `resources/fonts/MaterialSymbolsOutlined-Subset.woff2`、[完整许可](resources/fonts/MaterialSymbols-LICENSE.txt)、[来源与子集说明](resources/fonts/MaterialSymbols-NOTICE.txt)、HTML 对应文本块 |
| SlateRandom 应用图标 | 基于 Material Symbols `shuffle` | Apache-2.0 | Google LLC 字形；项目图标 | `resources/icons/icon-source.png`、`icon.png`、`icon.ico`；桌面包 `licenses/MaterialSymbols-LICENSE.txt` 与 NOTICE |
| node-edge-tts | 1.2.11 | MIT | Copyright © 2022 SchneeHertz | Windows 桌面包 `app.asar` 内的 `node_modules/node-edge-tts`，含包内 LICENSE |
| node-edge-tts 运行时依赖：`ws` / `https-proxy-agent` / `agent-base` / `debug` / `ms` | 8.22.0 / 7.0.6 / 7.1.4 / 4.4.3 / 2.1.3 | MIT | 各包作者，见包内 LICENSE | 同上；版本由 `pnpm-lock.yaml` 固定 |
| Electron | 44.7.2 | MIT；捆绑组件各自许可 | Electron contributors / 各上游项目 | Windows 可携带目录的 `LICENSE`、`LICENSES.chromium.html`；[Electron 上游许可](https://github.com/electron/electron/blob/main/LICENSE) |

字体使用官方字形，仅保留应用需要的图标，未修改字形轮廓。导出 HTML 将字体嵌入为数据 URL，不在使用时请求 Google Fonts。SheetJS 在本地解析 CSV、XLS、XLSX，不需要联网下载解析脚本。

`node-edge-tts` 调用的是微软 Edge TTS 的非官方在线接口，不是离线语音引擎；它只在用户主动启用远程朗读时使用。

## 构建与开发工具

以下工具不进入应用运行时，也不随源码归档分发；它们通过 `pnpm-lock.yaml` 安装，在开发或打包时使用。

| 工具 | 版本 | 许可证 |
| --- | --- | --- |
| Vite | 7.3.7 | MIT |
| TypeScript | 6.0.3 | Apache-2.0 |
| `@vitejs/plugin-vue` | 6.0.10 | MIT |
| `vue-tsc` | 3.3.13 | MIT |
| `tsx` | 4.23.15 | MIT |
| `@types/node` | 26.6.5 | MIT |
| `@electron/packager` | 20.3.0 | BSD-2-Clause |
| `fontkit` | 2.0.4 | MIT |
| `@resvg/resvg-js` | 2.6.2 | MPL-2.0 |
| pnpm | 12.11.2 | MIT |

`fontkit` 用于开发期的字体/字形处理，`@resvg/resvg-js` 用于生成应用图标；两者都不装入应用运行时。`@resvg/resvg-js` 使用 Windows 预编译插件，不要求本机安装 C++ 编译器。项目 Windows 权限辅助程序为独立 Win32 API 实现；GrantUiAccess 仅作为功能参考，没有复制或捆绑其 GPL 源码。

## 字体、图标与商标

- Material Symbols 字体和应用图标的许可见上文；Google、Material Symbols 是 Google LLC 的商标。
- 关于页友情链接中的 SecRandom、ICC-CE 名称与应用图标归各自项目所有，仅用于项目识别和跳转；SlateRandom 与它们没有隶属关系。
- GitHub 名称与 Octocat 标记是 GitHub, Inc. 的商标；关于页中的 GitHub 图标仅用于标识仓库链接。

## 完整许可证文本

- 项目自身：[LICENSE](LICENSE)（GPL-3.0-or-later）。
- SheetJS：[resources/vendor/SheetJS-LICENSE.txt](resources/vendor/SheetJS-LICENSE.txt)。
- Material Symbols：[resources/fonts/MaterialSymbols-LICENSE.txt](resources/fonts/MaterialSymbols-LICENSE.txt) 与 [NOTICE](resources/fonts/MaterialSymbols-NOTICE.txt)。
- 实际打包进 HTML 的 npm 依赖：许可证文本合并保存在 HTML 的 `dependencyLicenses` 文本块中。
- Electron 与 Chromium：Windows 可携带目录中的 `LICENSE`、`LICENSES.chromium.html`。
- 其余 MIT、Apache-2.0、BSD-2-Clause、MPL-2.0 组件：以包内 LICENSE 和上游仓库为准。

## 核对来源

- [Vue 官方许可证](https://github.com/vuejs/core/blob/main/LICENSE)
- [Vite 官方许可证](https://github.com/vitejs/vite/blob/main/LICENSE)
- [TypeScript 官方许可证](https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt)
- [Google Material Icons / Symbols 上游许可](https://github.com/google/material-design-icons/blob/master/LICENSE)
- [Material Color Utilities 许可](https://github.com/material-foundation/material-color-utilities/blob/main/LICENSE)
- [SheetJS 官方浏览器集成说明](https://docs.sheetjs.com/docs/getting-started/installation/standalone/)
- [Electron Packager 许可证（BSD-2-Clause）](https://github.com/electron/packager/blob/main/LICENSE)
- [fontkit 许可证（MIT）](https://github.com/foliojs/fontkit/blob/master/LICENSE)
- [resvg-js 许可证（MPL-2.0）](https://github.com/yisibl/resvg-js/blob/main/LICENSE)

用户配置的远程视觉与语音服务不属于捆绑组件；相关协议来源记录在 `src/providers-sources.txt` 和 `src/speech-providers-sources.txt`。项目代码中不包含服务密钥。
