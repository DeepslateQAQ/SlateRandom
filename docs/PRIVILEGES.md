# SlateRandom 岩选的 Windows UAC 与 UIAccess

SlateRandom 岩选默认使用普通用户权限。“通用”保留开机自启和 UIAccess 开关，提权方式使用一个可键盘操作的紧凑三段滑动选择器：未开启自启时为“禁用 / UAC / 兼容性”，开启后为“禁用 / UAC / 计划任务”。选择“禁用”同时关闭 UIAccess；切换自启保留提权启用状态和两种启动场景各自的方式偏好。

## 手动启动

UAC 模式由程序申请 Windows 授权，取消或失败保留现有实例。兼容性模式停止程序针对手动启动的自动 UAC 请求；该选项不修改注册表或 Windows 兼容性配置。用户需右键 `SlateRandom.exe` → 属性 → 兼容性 → 勾选「以管理员身份运行此程序」。Windows 仍可能显示 UAC；取消兼容性提权也需在 Windows 属性中取消勾选。UIAccess 是独立显式请求，不因兼容性偏好而跳过所需授权。

内部仍由 `uac` 保存是否启用提权，`manualElevation: 'uac' | 'compatibility'` 与 `autostartElevation: 'uac' | 'task'` 分别保存手动、登录启动偏好，默认均为 UAC。选择方式不会自动开启自启；禁用提权不会清除这两项偏好。

## 两种管理员自启方式

开启自启后，选择器提供 UAC 和计划任务两种提权方式。

- **UAC**：用 Electron `setLoginItemSettings` 注册当前用户的普通登录启动入口。下次登录时先启动普通进程，再根据保存的 UAC 偏好请求标准系统同意窗口；拒绝后保留普通权限实例。
- **计划任务**：开启自启并选择「计划任务」后使用。第一次注册时申请标准 UAC 同意，随后在 Task Scheduler 注册当前用户登录触发的 `InteractiveToken` / `HighestAvailable` 任务。任务使用当前用户的可用最高权限启动 SlateRandom，不保存密码，不以 SYSTEM 或服务账户运行，也不隐藏任务。

计划任务名称由应用 `userData` 的稳定 SHA256 派生，例如 `SlateRandom-0123456789ab`。创建、查询、切换和删除只针对该固定名称，并验证 XML 中的 SlateRandom 所有权 URI；不会枚举或删除其他任务。注册任务确认成功后，才移除普通 Run 启动入口，避免重复启动。切回 UAC 或关闭自启时，先确认删除该任务，再修改 Run 入口；UAC 取消时不改变之前的 Run 入口，也不保存新偏好。

任务的触发用户和运行 principal 都来自原主进程的真实 Windows 用户 SID。辅助程序确认提权后的用户 SID 与其一致，避免在输入另一个管理员账户的凭据后，错误地把任务注册给那个账户。因此计划任务方式要求当前登录账户属于管理员组；另一个管理员账户的凭据不作为当前用户的替代。

SID 格式校验接受规范十进制的本地／域账户及 `S-1-12-1-…` 云账户形式，限制 authority 和 subauthority 范围，并拒绝 SYSTEM、LocalService、NetworkService。该语法兼容不授予任何权限；原用户 SID 的真实 token 核对仍必须通过。云账户的计划任务是否可注册由 Windows 实际结果决定，应用不会为了通过校验加入域或换用另一个账户。

桌面设置通过自启变更、偏好落盘、必要的重启依次提交。失败或取消时会独立尝试恢复已成功改变的自启与偏好，任何补偿失败均显示真实错误；不会笼统声称原启动方式一定已保留。偏好内存值只在原子写入成功后更新。

计划任务已经以管理员权限启动时，UIAccess 申请直接进入已授权的辅助程序分支，无需重复弹出 UAC。应用主进程仍验证当前 token 和新实例 token；任务设置不直接代表 UIAccess 已获得。运行时不会反复重新注册任务，注册发生在用户修改启动设置时。

`src/main/privileges.cjs` 只接受主进程预先确定的程序路径和参数。renderer 的 IPC 不接受可执行文件、脚本、路径或命令行。

## 实际权限状态

`getStatus(pid)` 调用独立辅助程序，读取所指定进程的 `TokenElevation`、`TokenUIAccess` 与会话 ID，主界面据此展示实际权限状态。读取失败时返回错误。

`requestRelaunch({ uiAccess })` 创建新实例并确认其 PID 的真实令牌。主进程另通过一次性随机命名管道与令牌完成交接：新实例先在内存会话中加载主页面与悬浮球，确认隔离桥接、Vue 挂载与窗口显示，再取代旧实例的单实例锁。交接失败或超时会保留原窗口并恢复设置。

Chromium 在创建第一个页面之前也可能打开默认存储，因此新实例启动时先使用独立的临时 `sessionData`。旧进程完全退出、释放数据库后，新实例才以 `session.fromPath()` 打开正式的 `data/browser/`，加载正式窗口；正式窗口就绪后销毁预览。正式名单、设置和公平统计由便携文件仓库管理，预览无权改写；浏览器资料与旧版迁移仍保持原有会话。这样可避免跨进程数据库锁或预览写入造成空名单。交接完成后的正式加载若失败，会先销毁所有原生窗口以释放输入区域，再显示原生错误提示并退出。

窗口显示不再只依赖 `ready-to-show` 的首次绘制事件。加载、挂载检查和主窗口打开都有总超时，避免永远隐藏或一直等待。隐藏辅助程序的 `SW_HIDE` 启动状态可能传递给 GUI：UIAccess 的 `STARTUPINFO` 显式使用 `STARTF_USESHOWWINDOW / SW_SHOWNORMAL`，主窗口加载后使用 `showInactive()` 显示、再聚焦，并确认窗口实际可见。原生启动、页面就绪与交接事件写入用户数据目录的 `desktop-native.log`，仅包含进程、权限和窗口生命周期，不记录名单、密钥或命令行令牌。Chromium 沙箱、上下文隔离以及禁用 Node 集成继续保持。


当前 UIAccess 兼容路径默认禁用 DirectComposition，保留 GPU 光栅与 2D Canvas 加速，避免将整个应用退回软件渲染。光效使用局部渐变和近光以控制绘制成本。主进程每 1.5 秒维护置顶与 `moveTop`，不激活窗口；主界面显示时隐藏悬浮球，收起后以 `showInactive()` 恢复。悬浮球禁用键盘焦点，意外获得 focus 时也立即 blur。

权限不能从已经运行的进程中原地撤销。关闭选项后，当前实例仍可能具有管理员或 UIAccess 权限；完全退出，再从普通桌面正常打开即可按关闭后的偏好运行。默认不修改系统策略、不创建服务、不自动修改安全软件配置。

## 辅助程序实现

辅助程序是独立编写的 C# Win32 P/Invoke 工具，参考 GrantUiAccess 公开说明的令牌流程，未复制其 GPL 实现：

1. 默认 `asInvoker`，读取状态时不会请求管理员权限。
2. 需要权限时使用 `ShellExecuteExW` 的 `runas` 动词，等待系统 UAC 同意。
3. UIAccess 仅在管理员令牌已确认的情况下申请。取得当前会话、SYSTEM 身份且含 `SeTcbPrivilege` 的受信令牌后，仅在设置复制出来的**当前用户**主令牌 `TokenUIAccess` 时临时使用受信线程令牌。
4. `finally` 中调用 `RevertToSelf`，恢复原来的线程身份，再用当前用户的主令牌启动 SlateRandom。该组件不把应用启动为 SYSTEM，也不在后台持续使用 SYSTEM 线程身份。
5. 新进程的管理员与 UIAccess 状态均通过 `GetTokenInformation` 验证。临时句柄和权限在辅助程序内释放；UIAccess 失败不会伪装成普通置顶已获得 UIAccess。

该方式需要当前交互会话的管理员账户。若 UAC 要求输入另一个管理员账户的凭据，辅助程序可能无法使用原账户的临时结果目录及应用数据，此时会明确失败，保留原实例。Windows 策略、受保护进程设置或安全软件也可能拒绝令牌操作。

UIAccess 能改善同一交互桌面上的置顶能力，不能保证覆盖安全桌面、登录界面或任意 SYSTEM 界面。微软正式的 manifest UIAccess 部署路径还要求 Authenticode 签名、可信安装位置及 manifest；本组件采用管理员授权后的令牌申请路径，应分别验证目标 Windows 环境。没有更改这些签名或系统策略要求。

## 构建

运行 `node scripts/build-windows-helper.mjs --arch=x64` 或 `--arch=arm64`，使用 Windows 自带的 `.NET Framework 4.x` x64 `csc.exe`，无需 C++ 工具链或 npm 原生模块。x64 输出为 `build/windows/SlateRandom.Privileges.exe`，arm64 输出为 `build/windows/SlateRandom.Privileges-arm64.exe`；arm64 是架构中性的 AnyCPU IL 程序集，不是假称为 ARM64 原生二进制。每个架构的证明写入独立的 `build/windows/build-info-<arch>.json`。打包器会把实际构建文件复制为运行时约定的 `resources/windows/SlateRandom.Privileges.exe`，并使用对应 Electron 架构。
相关单元测试可用以下命令运行：

```sh
node --test tests/unit/main/autostart.test.cjs tests/unit/main/windows/privileges.test.cjs
```

## 参考

- [GrantUiAccess](https://github.com/HelloWRC/GrantUiAccess)：用户指定的功能参考，GPL-3.0；本工程不包含其代码。
- [ShellExecuteExW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecuteexw)：标准程序操作与用户取消错误。
- [TOKEN_INFORMATION_CLASS](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class)：`TokenElevation` 与 `TokenUIAccess`。
- [OpenProcessToken](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocesstoken)：读取进程令牌及权限约束。
- [DuplicateTokenEx](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-duplicatetokenex)：创建当前用户的主令牌与受信线程令牌。
- [SetTokenInformation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-settokeninformation)：设置令牌信息及所需权限。
- [CreateProcessAsUserW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw)：按指定主令牌创建进程。
- [RevertToSelf](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-reverttoself)：结束临时线程身份。
- [UIAccess 安全要求](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)：正式 manifest 路径的签名、可信目录与可访问界面边界。
- [Task Scheduler XML schema](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema)：当前用户登录触发、InteractiveToken 和 HighestAvailable。
- [TaskFolder.RegisterTask](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskfolder-registertask)：注册任务、交互登录方式、权限与安全描述符。
- [Task security contexts](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)：任务运行身份与最高权限限制。
- [Electron login settings](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows)：普通当前用户登录启动入口。
