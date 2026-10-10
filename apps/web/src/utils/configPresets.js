// 订阅转换「远程配置 / 模板」预设。
//
// 这份清单逐字取自 SubPilot-Archive 的 apps/server/src/subconv/presets.js（含分组名与组内顺序），
// 保持两边选出来的模板完全一致 —— 用户在两个项目之间切换时不会因为默认模板不同而得到
// 不同的策略组结构。
//
// 只在**前端**用到：选中的 URL 会作为 config= 参数直接交给 SubConverter-Extended 去拉取，
// 本项目的后端不参与，所以不必为此新增接口。

const COR = 'https://raw.githubusercontent.com/Aethersailor/Custom_OpenClash_Rules/main/cfg';
const CM = 'https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/config';
const ACL = 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config';
const GIST = 'https://gist.githubusercontent.com/tindy2013/1fa08640a9088ac8652dbd40c5d2715b/raw';
const GH = 'https://gist.github.com/jklolixxs';
const NL13 = 'https://raw.nameless13.com/api/public/dl';
const SCW = 'https://subweb.s3.fr-par.scw.cloud/RemoteConfig';
const SW = 'https://raw.githubusercontent.com/SleepyHeeead/subconverter-config/master/remote-config';
const MZ = 'https://raw.githubusercontent.com/Mazeorz/airports/master/Clash';
const FLY = 'https://raw.githubusercontent.com/flyhigherpi/merlinclash_clash_related/master/Rule_config';

/** 默认模板：Aethersailor/Custom_OpenClash_Rules 的 Custom_Clash 默认版 */
export const DEFAULT_CONFIG_URL = `${COR}/Custom_Clash.ini`;

export const CONFIG_SOURCE = {
    name: 'Aethersailor/Custom_OpenClash_Rules',
    repo: 'https://github.com/Aethersailor/Custom_OpenClash_Rules',
};

export const CONFIG_PRESET_GROUPS = [
    {
        label: 'Custom_OpenClash_Rules（默认底稿）',
        options: [
            { name: 'Custom_Clash 默认版', url: `${COR}/Custom_Clash.ini` },
            { name: 'Custom_Clash 精简版', url: `${COR}/Custom_Clash_Lite.ini` },
            { name: 'Custom_Clash 全量版', url: `${COR}/Custom_Clash_Full.ini` },
            { name: 'Custom_Clash 大陆版', url: `${COR}/Custom_Clash_Mainland.ini` },
            { name: 'Custom_Clash GFW版', url: `${COR}/Custom_Clash_GFW.ini` },
            { name: 'Custom_Clash 默认版(回落)', url: `${COR}/Custom_Clash_Fallback.ini` },
            { name: 'Custom_Clash 精简版(回落)', url: `${COR}/Custom_Clash_Lite_Fallback.ini` },
            { name: 'Custom_Clash 全量版(回落)', url: `${COR}/Custom_Clash_Full_Fallback.ini` },
            { name: 'Custom_Clash GFW版(回落)', url: `${COR}/Custom_Clash_GFW_Fallback.ini` },
        ],
    },
    {
        label: 'CM 规则',
        options: [
            { name: 'CM_Online 默认版（识别港美地区）', url: `${CM}/ACL4SSR_Online.ini` },
            { name: 'CM_Online_MultiCountry（负载均衡）', url: `${CM}/ACL4SSR_Online_MultiCountry.ini` },
            { name: 'CM_Online_MultiCountry_CF（CDN 负载均衡）', url: `${CM}/ACL4SSR_Online_MultiCountry_CF.ini` },
            { name: 'CM_Online_Full（多地区分组）', url: `${CM}/ACL4SSR_Online_Full.ini` },
            { name: 'CM_Online_Full_CF', url: `${CM}/ACL4SSR_Online_Full_CF.ini` },
            { name: 'CM_Online_Full_MultiMode（负载均衡）', url: `${CM}/ACL4SSR_Online_Full_MultiMode.ini` },
            { name: 'CM_Online_Full_MultiMode_CF', url: `${CM}/ACL4SSR_Online_Full_MultiMode_CF.ini` },
        ],
    },
    {
        label: '通用',
        options: [
            { name: '默认', url: `${ACL}/ACL4SSR_Online_Full_NoAuto.ini` },
            { name: '默认（自动测速）', url: `${ACL}/ACL4SSR_Online_Full_AdblockPlus.ini` },
            { name: '默认（索尼电视专用）', url: 'https://raw.githubusercontent.com/youshandefeiyang/webcdn/main/SONY.ini' },
            { name: '默认（附带 Clash 的 AdGuard DNS）', url: `${GIST}/default_with_clash_adg.yml` },
            { name: 'ACL_全分组 Dream 修改版', url: 'https://raw.githubusercontent.com/WC-Dream/ACL4SSR/WD/Clash/config/ACL4SSR_Online_Full_Dream.ini' },
            { name: 'ACL_精简分组 Dream 修改版', url: 'https://raw.githubusercontent.com/WC-Dream/ACL4SSR/WD/Clash/config/ACL4SSR_Mini_Dream.ini' },
            { name: 'emby-TikTok-流媒体分组-去广告加强版', url: 'https://raw.githubusercontent.com/justdoiting/ClashRule/main/GeneralClashRule.ini' },
            { name: '流媒体通用分组', url: 'https://raw.githubusercontent.com/cutethotw/ClashRule/main/GeneralClashRule.ini' },
        ],
    },
    {
        label: 'ACL 规则',
        options: [
            { name: 'ACL_默认版', url: `${ACL}/ACL4SSR_Online.ini` },
            { name: 'ACL_无测速版', url: `${ACL}/ACL4SSR_Online_NoAuto.ini` },
            { name: 'ACL_去广告版', url: `${ACL}/ACL4SSR_Online_AdblockPlus.ini` },
            { name: 'ACL_多国家版', url: `${ACL}/ACL4SSR_Online_MultiCountry.ini` },
            { name: 'ACL_无Reject版', url: `${ACL}/ACL4SSR_Online_NoReject.ini` },
            { name: 'ACL_无测速精简版', url: `${ACL}/ACL4SSR_Online_Mini_NoAuto.ini` },
            { name: 'ACL_全分组版', url: `${ACL}/ACL4SSR_Online_Full.ini` },
            { name: 'ACL_全分组谷歌版', url: `${ACL}/ACL4SSR_Online_Full_Google.ini` },
            { name: 'ACL_全分组多模式版', url: `${ACL}/ACL4SSR_Online_Full_MultiMode.ini` },
            { name: 'ACL_全分组奈飞版', url: `${ACL}/ACL4SSR_Online_Full_Netflix.ini` },
            { name: 'ACL_精简版', url: `${ACL}/ACL4SSR_Online_Mini.ini` },
            { name: 'ACL_去广告精简版', url: `${ACL}/ACL4SSR_Online_Mini_AdblockPlus.ini` },
            { name: 'ACL_Fallback精简版', url: `${ACL}/ACL4SSR_Online_Mini_Fallback.ini` },
            { name: 'ACL_多国家精简版', url: `${ACL}/ACL4SSR_Online_Mini_MultiCountry.ini` },
            { name: 'ACL_多模式精简版', url: `${ACL}/ACL4SSR_Online_Mini_MultiMode.ini` },
        ],
    },
    {
        label: '全网搜集规则',
        options: [
            { name: '常规规则', url: `${FLY}/ZHANG.ini` },
            { name: '酷酷自用', url: 'https://raw.githubusercontent.com/xiaoshenxian233/cool/rule/complex.ini' },
            { name: 'PharosPro 无测速', url: `${SCW}/special/phaors.ini` },
            { name: '分区域故障转移', url: `${FLY}/ZHANG_Area_Fallback.ini` },
            { name: '分区域自动测速', url: `${FLY}/ZHANG_Area_Urltest.ini` },
            { name: '分区域无自动测速', url: `${FLY}/ZHANG_Area_NoAuto.ini` },
            { name: 'OoHHHHHHH', url: 'https://raw.githubusercontent.com/OoHHHHHHH/ini/master/config.ini' },
            { name: 'CFW-TAP', url: 'https://raw.githubusercontent.com/OoHHHHHHH/ini/master/cfw-tap.ini' },
            { name: 'lhl77 全分组', url: 'https://raw.githubusercontent.com/lhl77/sub-ini/main/tsutsu-full.ini' },
            { name: 'lhl77 简易版', url: 'https://raw.githubusercontent.com/lhl77/sub-ini/main/tsutsu-mini-gfw.ini' },
            { name: 'ConnersHua 神机规则 Outbound', url: `${GIST}/connershua_new.ini` },
            { name: 'ConnersHua 神机规则 Inbound（回国专用）', url: `${GIST}/connershua_backtocn.ini` },
            { name: 'lhie1 洞主规则（Clash 分组）', url: `${GIST}/lhie1_clash.ini` },
            { name: 'lhie1 洞主规则完整版', url: `${GIST}/lhie1_dler.ini` },
            { name: 'eHpo1 规则', url: `${GIST}/ehpo1_main.ini` },
            { name: '多策略组默认白名单模式', url: `${NL13}/ROzQqi2S/white.ini` },
            { name: '多策略组可有效减少审计触发', url: `${NL13}/ptLeiO3S/mayinggfw.ini` },
            { name: '精简策略默认白名单', url: `${NL13}/FWSh3dXz/easy3.ini` },
            { name: '多策略增加 SMTP 策略', url: `${NL13}/L_-vxO7I/youtube.ini` },
            { name: '无策略入门推荐', url: `${NL13}/zKF9vFbb/easy.ini` },
            { name: '无策略入门推荐国家分组', url: `${NL13}/E69bzCaE/easy2.ini` },
            { name: '无策略仅 IPIP CN + Final', url: `${NL13}/XHr0miMg/ipip.ini` },
            { name: '无策略魅影 vip 分组', url: `${NL13}/BBnfb5lD/MAYINGVIP.ini` },
            { name: '品云专属（仅香港分组）', url: `${MZ}/Examine.ini` },
            { name: '品云专属（全地域分组）', url: `${MZ}/Examine_Full.ini` },
            { name: 'nzw9314 规则', url: `${GIST}/nzw9314_custom.ini` },
            { name: 'maicoo-l 规则', url: `${GIST}/maicoo-l_custom.ini` },
            { name: 'DlerCloud Platinum 李哥定制', url: `${GIST}/dlercloud_lige_platinum.ini` },
            { name: 'DlerCloud Gold 李哥定制', url: `${GIST}/dlercloud_lige_gold.ini` },
            { name: 'DlerCloud Silver 李哥定制', url: `${GIST}/dlercloud_lige_silver.ini` },
            { name: 'ProxyStorage 自用', url: 'https://unpkg.com/proxy-script/config/Clash/clash.ini' },
            { name: 'ShellClash 修改版规则', url: 'https://github.com/UlinoyaPed/ShellClash/raw/master/rules/ShellClash.ini' },
        ],
    },
    {
        label: '各大机场规则',
        options: [
            { name: 'EXFLUX', url: `${GH}/16964c46bad1821c70fa97109fd6faa2/raw/EXFLUX.ini` },
            { name: 'NaNoport', url: `${GH}/32d4e9a1a5d18a92beccf3be434f7966/raw/NaNoport.ini` },
            { name: 'CordCloud', url: `${GH}/dfbe0cf71ffc547557395c772836d9a8/raw/CordCloud.ini` },
            { name: 'BigAirport', url: `${GH}/e2b0105c8be6023f3941816509a4c453/raw/BigAirport.ini` },
            { name: '跑路云', url: `${GH}/9f6989137a2cfcc138c6da4bd4e4cbfc/raw/PaoLuCloud.ini` },
            { name: 'WaveCloud', url: `${GH}/fccb74b6c0018b3ad7b9ed6d327035b3/raw/WaveCloud.ini` },
            { name: '几鸡', url: `${GH}/bfd5061dceeef85e84401482f5c92e42/raw/JiJi.ini` },
            { name: '四季加速', url: `${GH}/6ff6e7658033e9b535e24ade072cf374/raw/SJ.ini` },
            { name: 'ImmTelecom', url: `${GH}/24f4f58bb646ee2c625803eb916fe36d/raw/ImmTelecom.ini` },
            { name: 'AmyTelecom', url: `${GH}/b53d315cd1cede23af83322c26ce34ec/raw/AmyTelecom.ini` },
            { name: 'LinkCube', url: `${SCW}/customized/convenience.ini` },
            { name: 'Miaona', url: `${GH}/ff8ddbf2526cafa568d064006a7008e7/raw/Miaona.ini` },
            { name: 'Foo&Friends', url: `${GH}/df8fda1aa225db44e70c8ac0978a3da4/raw/Foo&Friends.ini` },
            { name: 'ABCloud', url: `${GH}/b1f91606165b1df82e5481b08fd02e00/raw/ABCloud.ini` },
            { name: '咸鱼', url: `${SW}/customized/xianyu.ini` },
            { name: '便利店', url: 'https://subweb.oss-cn-hongkong.aliyuncs.com/RemoteConfig/customized/convenience.ini' },
            { name: 'CNIX', url: `${MZ}/SSRcloud.ini` },
            { name: 'Nirvana', url: 'https://raw.githubusercontent.com/Mazetsz/ACL4SSR/master/Clash/config/V2rayPro.ini' },
            { name: 'V2Pro', url: `${MZ}/V2Pro.ini` },
            { name: '史迪仔-自动测速', url: `${MZ}/Stitch.ini` },
            { name: '史迪仔-负载均衡', url: `${MZ}/Stitch-Balance.ini` },
            { name: 'Maying', url: `${SW}/customized/maying.ini` },
            { name: 'Ytoo', url: `${SCW}/customized/ytoo.ini` },
            { name: 'w8ves', url: `${NL13}/M-We_Fn7/w8ves.ini` },
            { name: 'NyanCAT', url: `${SW}/customized/nyancat.ini` },
            { name: 'Nexitally', url: `${SCW}/customized/nexitally.ini` },
            { name: 'SoCloud', url: `${SW}/customized/socloud.ini` },
            { name: 'ARK', url: `${SW}/customized/ark.ini` },
            { name: 'N3RO', url: `${GIST}/n3ro_optimized.ini` },
            { name: 'Scholar', url: `${GIST}/scholar_optimized.ini` },
            { name: 'Flowercloud', url: `${SCW}/customized/flower.ini` },
        ],
    },
    {
        label: '特殊',
        options: [
            { name: 'NeteaseUnblock', url: `${SW}/special/netease.ini` },
            { name: 'Basic', url: `${SW}/special/basic.ini` },
        ],
    },
];

/** url → 显示名，用于把「当前值」反查成下拉框里的一项 */
export const PRESET_NAME_BY_URL = Object.fromEntries(
    CONFIG_PRESET_GROUPS.flatMap((g) => g.options).map((o) => [o.url, o.name]),
);

// ---------------------------------------------------------------- 上次用过的配置

/**
 * 「上一次用过的外部配置」。
 *
 * 背景：以前每次进转换页，「外部配置 / 模板」都回到内置默认（Custom_Clash 默认版）。
 * 用户上次挑的自定义地址只活在「记住这个地址」的那个列表里 —— 回来还得再点一次，
 * 实际体验就是「明明存过，下次还是默认」，白存。
 *
 * 语义：
 *   · 记的是**用户选过 / 填过的那个地址**（自定义地址与预设都算），
 *     下次进转换页直接拿它当「外部配置 / 模板」的初值；
 *   · 空值（= 不套模板）**不写入** —— 那是针对某一次转换的临时选择，
 *     让它变成常驻默认会导致下次进来莫名其妙地不带模板；
 *   · 与「记住这个地址」的列表（sp_conv_config_list）互不影响：那个是备选清单，
 *     这个是当前默认值。原有功能一个都没动。
 *   · 写不进去（隐私模式 / 禁用存储）静默忽略，退回内置默认，不影响使用。
 */
export const CONFIG_LAST_KEY = 'sp_conv_config_last';

/** 读上次用过的配置地址；没有 / 读不到时返回空串（调用方回落到 DEFAULT_CONFIG_URL） */
export function readLastConfig() {
    try {
        return String(localStorage.getItem(CONFIG_LAST_KEY) || '').trim();
    } catch {
        return '';
    }
}

/** 记下这次用的配置地址。空值忽略（见上：不套模板不该成为常驻默认）。 */
export function writeLastConfig(v) {
    const t = String(v || '').trim();
    if (!t) return;
    try {
        localStorage.setItem(CONFIG_LAST_KEY, t);
    } catch {
        /* 隐私模式写不进去也不影响使用 */
    }
}
