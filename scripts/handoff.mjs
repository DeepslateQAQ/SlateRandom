export function handoffText({ html, hash, report, unitTests, suiteCounts, completedAt, desktop, pkg }) {
  return `SlateRandom 岩选开发交接
更好玩好用的随机抽选
作者：DeepslateQAQ（https://github.com/DeepslateQAQ）
更新时间：${new Date().toISOString()}
最终 HTML：${html.length} bytes；SHA256 ${hash}
工具链：Vue ${pkg.dependencies.vue} / TypeScript ${pkg.devDependencies.typescript} / Vite ${pkg.devDependencies.vite} / ${pkg.packageManager} / Electron ${pkg.devDependencies.electron}。
验证：${report.checks.length} 项浏览器、开发入口和真实桌面检查通过；严格类型检查通过，${unitTests.total} 项单元测试通过；运行时异常与测试失败均为 0。
分组：${Object.entries(suiteCounts).map(([name, count]) => name + ' ' + count).join('，')}。
报告完成时间：${completedAt}。

交付：
- 下载目录“点到-2026-10-11”的 SlateRandom-Lite.html、兼容文件点到.html、使用说明、验证报告、预览、完整源码和 SlateRandom Windows x64 可携带 ZIP；两个下载 HTML 与桌面原 HTML 同字节。
- 桌面“${desktop.split(/[\\/]/).at(-1)}”同步替换，保留原 HTML 路径便于继续使用浏览器数据。
- 桌面 SlateRandom 岩选快捷方式打开下载目录的实际桌面应用。单击主界面关闭键只收起；长按 500 ms 确认、悬浮球静止长按 3 秒确认或通知区退出才结束程序。更新应用保留目标目录现有 data/。

本次实现：
- 默认没有演示名单；短按打开名单与座位配置。全览空状态显示“名单不可用”。只移除旧版自动插入、未经修改的演示名单，导入名单与真实统计保留。
- Electron 置顶无边框、居中固定大小主界面与绿黑悬浮球；拖动吸附左右边缘，静止长按 3 秒展开退出确认；最左下角为低亮度红色关闭图标，长按 500 ms 展开退出确认。主界面不占任务栏，通知区提供主界面、设置与退出入口。
- 悬浮球长按使用绿色球体外的顺时针非线性进度环。触摸移动修复客户区／屏幕坐标差异与分数 DPI 尺寸反馈，逐帧合并和平滑，抬手提交真实终点后吸附；主界面打开隐藏球体，定时置顶不夺取焦点。
- 场景复用座位节点、方向几何与时间候选，减少重复测量，并使用局部渐变绘制光晕。性能记录见随附报告。
- 设置重组为通用、功能、名单、数据、帮助、关于六页；模式行的概率、开关与详情同处功能页，累计统计和所有备份集中在数据页。浏览器版名称为 SlateRandom 岩选 Lite，隐藏桌面控件。
- 桌面数据保存在实际程序旁的 data/，名单／设置为 JSON，公平统计、随机状态与历史为带完整性校验的二进制。首次复制旧 AppData 资料后转换，旧原件保留；已有便携数据优先，完整目录搬迁后继续使用。
- 数据页可单独导出设置／名单 JSON 或 .slate 全量备份，Lite 与桌面互通；API 密钥默认不导出，需要迁移时可手动开启。
- 通用设置提供开机自启、UAC 和 UIAccess。UAC 自启动可选自动提权或当前用户最高权限计划任务；UIAccess 要求 UAC，权限显示读取真实令牌。
- UIAccess 使用兼容渲染路径，支持主窗口与悬浮球切换；权限交接失败时继续使用原窗口。
- 无法确认的学号由模型省略或留 null。程序按左上角逐行补全；优先姓名匹配，保留旧确认学号或使用新的明确学号，并迁移历史、公平统计与友尽引用。
- 纯名单表格不编造座位坐标；能匹配已有座位则沿用，没有完整匹配则询问行列后按学号排序排座。支持只有表格而没有图片的识别。
- 右下角改为单一“全览”切换按钮，图标+文字，aria-pressed 表示全览状态；点击、触摸与键盘均经原视图控制器保留入退场。移除悬浮展开和滑选；电影专用脚本、样式、镜头与转场均已移除，旧 cinema/cinematic 存档和备份自动转为普通且不改统计、历史与PRNG。
- 功能页第五行“结果跳变”独立提供概率和 endJumpEnabled 开关，关闭保留 endJumpChance；不计入模式概率总和，改选仍遵守公平保护。附加入口更名“朗读设置”。继续保留方向每轮随机与冷却、友尽、Z 入退场、非线性动画、泛光、实时日期时间 FLIP、MiMo 与兼容 TTS。

验证范围：
回归视觉和语音使用本机模拟服务，不调用实际付费 API。桌面验证实际运行 Electron 与发布后的 SlateRandom.exe；额外 Windows 权限验收使用隔离配置，实际完成 UAC → 管理员 → UIAccess 两次窗口交接，核对真实令牌与主窗口／悬浮球可见性。没有替用户开启系统自启或注册真实计划任务。

数据与源码：
领域 version 1 schema 保持。Lite 继续使用 localStorage 的 rollcall-studio:v1 和独立提供商 IndexedDB；桌面通过受限 preload 保存到 data/roster.json、settings.json、statistics.srstat 与 .fairness-key，桌面偏好为 desktop-settings.json，浏览器会话在 data/browser/。密钥不进入名单、CSV 或源码；完整备份及设置备份只有显式勾选才包含密钥。明细上限 2000 条，长期公平统计持续保留。
统计与备份使用带完整性校验的二进制文件。包含 API 密钥的备份请妥善保管，勿公开分享。
源码 ZIP 从干净 staging 制作，逐项校验 SHA；不包含依赖目录、data/、个人配置、测试浏览器用户数据或旧迁移备份。原生 ZIP 同样拒绝包含个人 data/，并逐文件核对当前发布目录 SHA。项目原创代码采用 GNU GPL 第 3 版或更新版本（GPL-3.0-or-later），完整许可随发行目录及 Lite HTML 一同提供；第三方组件保留各自许可与版权声明。分发应用时须按 GPL 提供相应源代码；未发布到外部仓库。

开发与验证（Windows）：
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm dev
pnpm desktop:install
pnpm desktop:dev
pnpm desktop:build
node scripts/verify-toolchain.mjs
浏览器和桌面 QA 必须依次运行：tests/e2e/qa.mjs、tests/e2e/qa-extra.mjs、tests/e2e/qa-ui.mjs、tests/e2e/qa-friend.mjs、tests/e2e/qa-render-styles.mjs、tests/e2e/qa-speech.mjs、tests/e2e/qa-settings-layout.mjs、tests/e2e/qa-dev-smoke.mjs、tests/e2e/qa-import.mjs、tests/integration/qa-desktop.mjs、tests/integration/qa-packaged.mjs、tests/integration/qa-portable.mjs。权限交接另用 tests/native/qa-uiaccess.mjs 实测；会请求 Windows UAC，同样不可与其他窗口验收并行。
所有报告必须对应当前 HTML，packaged／portable／UIAccess 还须绑定同一 app.asar，实际解压及便携验收须绑定同一原生 ZIP，node scripts/export.mjs 才会导出。README.md、README.txt、docs/ARCHITECTURE.md、docs/PORTABLE_DATA.md、docs/PRIVILEGES.md、CONTRIBUTING.md 与 THIRD_PARTY_NOTICES.md 提供开发说明。
`;
}
