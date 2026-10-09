// 浏览器密码管理器的「别碰这个框」声明。
//
// ---- 为什么要专门搞这一层 ----
// 本项目的密码框存的是**应用自己的密钥**（访问令牌 / AI Key / Gist PAT /
// WebDAV 应用密码 / TG Bot Token），不是用户在这个站点上的登录凭据。
// 访问令牌更是已经存在 localStorage（登录页文案写着「之后免登录」），
// 浏览器再存一份只会把它同步进 Google 账号 —— 纯属多一个泄露面。
//
// 但 Chrome 只要在页面上看到一个 `type="password"`，就会把整页判成登录表单，
// 然后把旁边的普通文本框当成「用户名」来填。实测表现：在「设置 → AI 助手」
// 点模型输入框，弹出的是浏览器里存的其他站点的账号
// （admin (2026/5/27) mail.ynotu.top 之类），把 datalist 的模型列表整个盖掉。
//
// ---- 怎么治（实测结论，别只信 autocomplete）----
//   ① 密码框用 `autocomplete="new-password"`：
//      这是**唯一**能让 Chrome 放弃填充已存密码的取值 ——
//      对密码框写 `autocomplete="off"` 是无效的，Chrome 会忽略。
//   ② **页面上尽量别有裸 `type="password"`**：Chrome 的「登录表单」判定是页面级的，
//      只要有密码框，旁边的普通文本框就会被当「用户名」，聚焦时弹账号列表。
//      autocomplete="off" 拦不住这条启发式 —— 设置页的模型输入框曾经照做还是弹。
//      所以 API Key 这类「已保存就不需要展示」的字段改成**点击后才渲染输入框**，
//      平时页面上根本没有密码框，启发式无从启动。
//   ③ 文本框再叠一层 **readonly-until-focus**：Chrome 对只读字段不弹任何建议。
//      初始 readonly、`@focus` 时解锁。两层叠加后弹窗彻底消失。
//   ④ 候选列表用**自绘面板**而不是原生 datalist：datalist 是浏览器 UI，
//      账号弹窗能盖在它上面；自绘面板在页面文档里，不受影响。
//   ⑤ 顺手挂上各家密码管理器的忽略标记。
//
// ---- 密钥框的终极形态（v3，2026-10-09）----
// `new-password` 只能阻止 Chrome **填**已存密码；登录页提交令牌后它照样弹
// 「保存密码？」，把本该只存 localStorage 的令牌同步进 Google 账号。
// 根治：**`type="text"` + CSS `-webkit-text-security: disc`** ——
// 视觉上仍是圆点，但密码管理器的启发式根本不认它是凭据字段，
// 账号列表、保存密码气泡统统不会出现。Chrome / Edge / Safari 都支持；
// 不支持的浏览器（Firefox）由 `secretFieldProps()` 特性检测回退成
// `type="password"` + `new-password`，最多享受 v2 效果。
//
// 用法：`<input v-model="x" v-bind="secretFieldProps()" name="sp-xxx" ...>`
// （不要再写静态 type —— 模板里单独的 attribute 会覆盖 v-bind 对象里的值）
//
// 注意：`name` 不要写成 user / login / email / password 这类词，
// 那正好是 Chrome 用来识别凭据字段的关键字。

/** 普通输入框：声明「不要自动填充」 */
export const NO_AUTOFILL = {
    autocomplete: 'off',
    'data-1p-ignore': 'true', // 1Password
    'data-lpignore': 'true', // LastPass
    'data-bwignore': 'true', // Bitwarden
    'data-protonpass-ignore': 'true', // Proton Pass
};

/**
 * 密码类输入框 v2：同上，但 `autocomplete` 必须换成 `new-password`。
 * 直接复用 NO_AUTOFILL 再覆盖，避免两处漂移。
 */
export const NO_AUTOFILL_SECRET = {
    ...NO_AUTOFILL,
    autocomplete: 'new-password',
};

/** 当前浏览器是否支持 `-webkit-text-security`（Chrome / Edge / Safari 支持，Firefox 不支持） */
export function supportsTextSecurity() {
    return typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
        && CSS.supports('-webkit-text-security', 'disc');
}

/**
 * 密钥类输入框 v3（推荐）：`type="text"` + 圆点伪装。
 * 密码管理器的启发式只认 `type="password"`，text 框不管长什么样都不会触发
 * 账号列表 / 保存密码气泡；不支持的浏览器回退 v2（password + new-password）。
 * 返回新对象，可直接 `v-bind`；调用方**不要再写静态 type**。
 */
export function secretFieldProps() {
    if (supportsTextSecurity()) {
        return {
            ...NO_AUTOFILL,
            autocomplete: 'off',
            type: 'text',
            style: { '-webkit-text-security': 'disc' },
        };
    }
    return { ...NO_AUTOFILL_SECRET, type: 'password' };
}
