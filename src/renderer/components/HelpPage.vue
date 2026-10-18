<template>
  <section id="view-help" class="view" aria-label="操作指南">
    <div class="page-heading"><div><h2>操作指南</h2><p class="page-description">从配置名单，到在另一台设备继续上课。</p></div></div>
    <div class="help-grid">
      <article class="card help-card"><span class="help-number">01</span><h2>导入名单与座位</h2>
        <p>进入「名单」页面，点击「导入名单」。每行填写一位姓名，学号会自动生成；也可使用「学号,姓名」或「学号,姓名,行,列」。支持 TXT / CSV，以及图表识别中的 CSV / XLS / XLSX 参考表。</p>
        <p>座位图与含学号的参考表可以同时提供给模型。在导入页的提供商设置中选择预设、填写 API 密钥，识别后核对姓名、学号与坐标。讲台所在一侧是第一行，模型应先校正方向，再移除空白边缘行列。</p>
        <p>模型无法确认学号时只给姓名与坐标，程序优先沿用同名同学已有的非自动学号，其余从左上角逐行补全。只有姓名和学号的名单会匹配已有座位；无法匹配时先询问教室尺寸，再按学号顺序填充。</p>
        <button class="text-btn" data-import>导入我的名单<span class="icon material-icon" aria-hidden="true">arrow_forward</span></button>
      </article>
      <article class="card help-card"><span class="help-number">02</span><h2>配置抽选功能</h2>
        <p><strong>随机混合：</strong>在「功能」页面调整连坐与时间的触发概率，剩余概率分配给普通随机。每个模式行中可直接调整概率和开关，点击行内其他区域可进入附加设置。「指定模式」优先使用选定方式；无法抽选时自动换用可用方式。</p>
        <p><strong>方向接力：</strong>从上一个人的紧邻座位继续，每轮重新随机可用方向。持续轮数与结束后的冷却均可设置最少和最多值；也可点击「退出连坐」提前结束。边界、空座或公平保护挡住全部方向时自动结束接力。</p>
        <p><strong>时间学号：</strong>将本地日期或时间写成连续数字，从能匹配当前候选的连续两位中随机选取。指定取位失效时先换位，全部无效再换模式；动画期间秒数持续更新，揭晓时核对并锁定。</p>
        <p><strong>友尽模式：</strong>在「名单」座位图点击同学，再点击「友尽」，红色多选其他同学并保存。下次抽选先尝试独立的友尽概率；目标依旧遵守公平保护。关闭友尽功能会保留已设置的目标。</p>
        <button id="helpSettingsBtn" class="text-btn">调整抽选功能<span class="icon material-icon" aria-hidden="true">arrow_forward</span></button>
      </article>
      <article class="card help-card"><span class="help-number">03</span><h2>理解长期公平</h2>
        <p>当前覆盖轮优先未抽过的同学，近期抽中过的同学进入冷却。累计少抽、经常较晚抽到的人增权；累计多抽、经常较早抽到的人减权。累计次数与出场位次跨会话保存，重置本轮不会清除。</p>
        <p>所有参与者轮满后，下次抽选会自动清空当前覆盖状态并继续，保留上一位的位置与长期统计。只有一人参与时该同学会重复出现；人数较少时冷却窗口会自动缩小。</p>
        <details><summary>概率如何计算？</summary><p>先选出本轮还没抽过、且不在冷却中的同学，再根据累计次数和出场先后调整抽中概率。方向、时间和友尽模式会从符合各自规则的同学中抽选；当前模式不可用时，自动换用其他模式。</p><p>「数据」页面可查看每位同学的累计次数和出场先后，包括已暂停参与的同学。</p></details>
      </article>
      <article class="card help-card"><span class="help-number">04</span><h2>按钮、快捷键与画面</h2>
        <p>短按抽选按钮或空格键抽人。按住不足 200 ms 松手视为短按，200～500 ms 松手仅撤回进度，持续 500 ms 打开设置。R 键与重置按钮均需长按 500 ms；Q 键退出连坐。</p>
        <p>点击右下角「全览」按钮，在普通与全览之间切换；按钮亮起时始终显示所有座位。普通视图跟随当前焦点。按钮支持触摸、回车与空格操作。</p>
        <p>桌面版点击悬浮球打开主界面，左下角红色按钮收回主界面。拖动悬浮球靠近左右屏幕边缘会吸附，按住悬浮球 3 秒后确认退出。</p>
        <p>桌面版还可用 <code>slaterandom://</code> 从外部控制：<code>slaterandom://pick</code> 立刻抽人，<code>slaterandom://main/show</code>、<code>hide</code>、<code>toggle</code> 控制主界面，<code>slaterandom://settings/show</code>、<code>hide</code>、<code>toggle</code> 开关设置，<code>slaterandom://ball/show</code>、<code>hide</code>、<code>toggle</code>、<code>click</code> 控制悬浮球，<code>slaterandom://import</code> 配合 <code>kind</code> 与 <code>source</code> 参数导入备份。动作也可写成 <code>?action=</code> 查询形式。</p>
        <p>浏览器版可在「数据」页使用「发送到桌面版」：按「备份中包含 API 密钥」开关导出全部备份、写入剪贴板，再唤醒桌面版确认恢复。</p>
      </article>
      <article class="card help-card"><span class="help-number">05</span><h2>备份与便携数据</h2>
        <p>「数据」页面统一管理备份。设置与名单可各自导出 JSON；「导出全部」还包含累计公平统计和当前抽取进度，可在另一台设备恢复。API 密钥默认不写入导出文件，需要时手动开启「备份中包含 API 密钥」。</p>
        <p>Windows 桌面版将便携数据保存在程序运行目录旁的 data 目录。名单与设置为 JSON，公平统计使用带完整性校验的二进制文件。复制整个程序目录可同时带走数据，也可通过全部备份迁移。</p>
        <p>如果提示统计文件损坏，请保留原文件，并在「数据」页面使用全部备份恢复。</p>
        <p>HTML 版本的数据保存在当前浏览器。更换设备、浏览器或 HTML 文件位置前，请先导出全部备份；在新位置导入后即可继续。撤销上轮会恢复当时的完整抽选状态，保留的明细最多 2000 条，累计统计持续保留。</p>
      </article>
    </div>
  </section>
</template>
