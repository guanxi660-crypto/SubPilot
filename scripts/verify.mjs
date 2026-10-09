// 本地验证脚本：跑一遍「建订阅 → JSON 脚本处理 → 转换委派 → feed」全链路。
// 用法：node scripts/verify.mjs [baseUrl]
// 不依赖任何测试框架，失败即非零退出，方便直接看输出。

const BASE = process.argv[2] || 'http://127.0.0.1:8795';
const TOKEN = process.env.SPX_TOKEN || 'dev-local-token';

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
    if (cond) {
        pass += 1;
        console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
    } else {
        fail += 1;
        console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
    }
}

async function req(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (options.auth !== false) headers.Authorization = `Bearer ${TOKEN}`;
    const res = await fetch(`${BASE}${path}`, { ...options, headers });
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        /* 非 JSON */
    }
    return { res, text, json };
}

function b64(s) {
    return Buffer.from(s, 'utf8').toString('base64');
}

// ---- 测试用节点 ----
const vmessObj = {
    v: '2',
    ps: '香港 中转 01',
    add: 'hk1.example.com',
    port: '443',
    id: '11111111-2222-3333-4444-555555555555',
    aid: '0',
    scy: 'auto',
    net: 'ws',
    type: 'none',
    host: 'hk1.example.com',
    path: '/ws',
    tls: 'tls',
};

const NODES = [
    'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@1.2.3.4:8388#香港%2001',
    'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@1.2.3.5:8388#日本%2001',
    'trojan://pass@5.6.7.8:443?sni=example.com#美国%20洛杉矶',
    `vmess://${b64(JSON.stringify(vmessObj))}`,
    'vless://11111111-2222-3333-4444-555555555555@9.9.9.9:443?encryption=none&security=tls#新加坡%2001',
    'hysteria2://pass@10.0.0.1:443?sni=example.com#台湾%2001',
    'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@1.2.3.9:8388#剩余流量：100GB',
    'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@1.2.3.10:8388#官网%20example.com',
    'trojan://pass@5.6.7.9:443#香港%2001', // 与第 1 条重名，测去重
];

const SUB_NAME = '__verify_sub__';
const PROCESS = [
    { type: 'Useless Filter', args: {} },
    { type: 'Regex Filter', args: { regex: ['(?i)剩余|官网|流量'], mode: 'exclude' } },
    { type: 'Region Filter', args: { regions: ['HK', 'JP', 'US', 'SG', 'TW'], mode: 'keep' } },
    { type: 'Handle Duplicate', args: { action: 'rename' } },
    { type: 'Flag Operator', args: { mode: 'add' } },
    { type: 'Sort Operator', args: { sort: 'asc', by: 'region' } },
];

async function main() {
    console.log(`\n== SubPilot 本地验证 @ ${BASE} ==\n`);

    // 0. 鉴权
    console.log('[0] 鉴权');
    const noAuth = await req('/api/subs', { auth: false });
    ok('无令牌访问受保护接口返回 401', noAuth.res.status === 401, `HTTP ${noAuth.res.status}`);
    const badAuth = await req('/api/subs', { auth: false, headers: { Authorization: 'Bearer wrong-token' } });
    ok('错误令牌返回 401', badAuth.res.status === 401, `HTTP ${badAuth.res.status}`);

    // 1. 环境
    console.log('\n[1] 环境信息');
    const env = await req('/api/utils/env');
    ok('/api/utils/env 可用', env.res.ok, env.json?.data?.subBackend || '');
    console.log(`    转换后端：${env.json?.data?.subBackend}  在线=${env.json?.data?.online}  版本=${env.json?.data?.sceVersion || '(未解析)'}`);

    // 2. 算子元数据
    console.log('\n[2] 算子元数据');
    const meta = await req('/api/operators');
    ok('返回算子类型表', (meta.json?.data?.types || []).length > 8, `${meta.json?.data?.types?.length} 种`);
    ok('返回算子模板', (meta.json?.data?.presets || []).length > 0, `${meta.json?.data?.presets?.length} 套`);
    // 目标格式表：2026-10-09 按 `docs/目标格式体检报告.md` 裁剪到 8 个。
    // 这里不卡死数量（微调就挂），而是断言「几个必留格式都在」。
    const targets = meta.json?.data?.targets || [];
    ok('返回目标格式表', targets.length >= 8, `${targets.length} 个`);
    ok(
        '目标格式表含 clash / singbox / shadowrocket',
        ['clash', 'singbox', 'shadowrocket'].every((v) => targets.some((t) => t.value === v)),
        targets.map((t) => t.value).join(','),
    );

    // 2b. 内置模板形状 + Regex Rename 的「成对替换」（回归）
    // 这里盯的是一个曾经真实存在的坑：Regex Rename 的 regex 是**扁平数组、两两一组**，
    // 而 asArray() 会把空串过滤掉 —— 于是「替换成空串」（削前缀最常用的写法）被静默丢弃，
    // 整个 pairs 数组左移错位；只剩 1 个元素时循环条件 i+1<len 直接不成立，整步变 no-op。
    // 内置模板原来的「削机场前缀」就一直是空转的。
    console.log('\n[2b] 内置模板与正则重命名');
    const presets = meta.json?.data?.presets || [];
    ok('内置模板只剩 1 条', presets.length === 1, `${presets.length} 条`);
    const preset = presets[0] || {};
    const ptypes = (preset.process || []).map((o) => o.type);
    ok('内置模板不含 Region Filter（地区取舍交给用户自己加）', !ptypes.includes('Region Filter'));
    ok('内置模板只有一个 Regex Rename（两组替换已合并）', ptypes.filter((t) => t === 'Regex Rename').length === 1);
    const rnOp = (preset.process || []).find((o) => o.type === 'Regex Rename');
    ok(
        'Regex Rename 的 regex 是 4 元素（两组替换）',
        (rnOp?.args?.regex || []).length === 4,
        JSON.stringify(rnOp?.args?.regex),
    );
    ok('内置模板以国旗收尾', ptypes[ptypes.length - 1] === 'Flag Operator', ptypes[ptypes.length - 1] || '');
    ok('内置模板里去重排在改名之后', ptypes.indexOf('Handle Duplicate') > ptypes.indexOf('Regex Rename'));

    // 造几条带「机场名 | 地区」前缀的节点（竖线同时用半角与全角，空格故意留双份）
    const mkNode = (name) =>
        `ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@1.2.3.4:8388#${encodeURIComponent(name)}`;
    const RENAME_NODES = [mkNode('机场A | 香港 01'), mkNode('机场B｜日本  东京'), mkNode('无前缀节点')];
    const previewProcess = async (process) => {
        const r = await req('/api/preview/process', {
            method: 'POST',
            body: JSON.stringify({ content: b64(RENAME_NODES.join('\n')), process }),
        });
        return { res: r.res, names: (r.json?.data?.processed || []).map((n) => n.name) };
    };

    const mergedRn = await previewProcess([
        { type: 'Regex Rename', args: { regex: ['^[^|｜]*[|｜]\\s*', '', '\\s{2,}', ' '] } },
    ]);
    ok('预览接口可用', mergedRn.res.ok, `HTTP ${mergedRn.res.status}`);
    ok('「替换成空串」确实生效（机场前缀被削掉）', mergedRn.names.includes('香港 01'), mergedRn.names.join(' / '));
    ok('同一步里的第二组替换也生效（连续空格压平）', mergedRn.names.includes('日本 东京'), mergedRn.names.join(' / '));
    ok('没有前缀的节点保持原样', mergedRn.names.includes('无前缀节点'));

    const splitRn = await previewProcess([
        { type: 'Regex Rename', args: { regex: ['^[^|｜]*[|｜]\\s*', ''] } },
        { type: 'Regex Rename', args: { regex: ['\\s{2,}', ' '] } },
    ]);
    ok(
        '合并成一条与拆成两条结果完全一致',
        JSON.stringify(mergedRn.names) === JSON.stringify(splitRn.names),
        splitRn.names.join(' / '),
    );

    // 空模式必须被跳过：new RegExp('', 'g') 会在每个字符间隙匹配，把替换文本插得到处都是
    const emptyPattern = await previewProcess([{ type: 'Regex Rename', args: { regex: ['', 'X'] } }]);
    ok('空模式被跳过（不会往名字里插 X）', !emptyPattern.names.some((n) => n.includes('X')), emptyPattern.names.join(' / '));

    // 3. 清理旧数据
    await req(`/api/sub/${encodeURIComponent(SUB_NAME)}`, { method: 'DELETE' });

    // 4. 创建订阅（本地内容）
    console.log('\n[3] 创建订阅');
    const create = await req('/api/subs', {
        method: 'POST',
        body: JSON.stringify({
            name: SUB_NAME,
            displayName: '验证用订阅',
            source: 'local',
            content: b64(NODES.join('\n')),
            process: PROCESS,
        }),
    });
    ok('创建成功', create.res.status === 201, `HTTP ${create.res.status}`);
    ok('写操作返回最新集合（规避 KV 最终一致）', Array.isArray(create.json?.data), `长度 ${create.json?.data?.length}`);

    // 5. 重名冲突
    const dup = await req('/api/subs', {
        method: 'POST',
        body: JSON.stringify({ name: SUB_NAME, source: 'local', content: 'x' }),
    });
    ok('同名创建返回 409', dup.res.status === 409, `HTTP ${dup.res.status}`);

    // 6. 预览 + 算子链
    console.log('\n[4] JSON 脚本处理');
    const preview = await req('/api/preview/sub', {
        method: 'POST',
        body: JSON.stringify({
            name: SUB_NAME,
            source: 'local',
            content: b64(NODES.join('\n')),
            process: PROCESS,
        }),
    });
    const nodes = preview.json?.data?.processed || [];
    ok('预览成功', preview.res.ok, `${nodes.length} 个节点（原始 ${NODES.length}）`);
    ok('无效节点被过滤（剩余流量 / 官网）', !nodes.some((n) => /剩余|官网/.test(n.name)));
    ok('重名已加序号', nodes.some((n) => /#2$/.test(n.name)) || new Set(nodes.map((n) => n.name)).size === nodes.length);
    ok('国旗已加', nodes.some((n) => /[\u{1F1E6}-\u{1F1FF}]{2}/u.test(n.name)));
    ok('节点数减少', nodes.length < NODES.length, `${NODES.length} → ${nodes.length}`);
    console.log('    处理后节点：');
    for (const n of nodes) console.log(`      - ${n.name}  (${n.type} ${n.server}:${n.port})`);
    if (preview.json?.data?.log?.length) {
        console.log('    算子日志：');
        for (const l of preview.json.data.log) console.log(`      · ${l}`);
    }

    // 7. feed（SCE 从这里拉处理结果）
    console.log('\n[5] /feed 端点与分发密钥');
    const feedNoAuth = await fetch(`${BASE}/feed/sub/${encodeURIComponent(SUB_NAME)}`);
    ok('无凭证访问 feed 返回 403', feedNoAuth.status === 403, `HTTP ${feedNoAuth.status}`);

    const linkRes = await req(`/api/link?kind=sub&name=${encodeURIComponent(SUB_NAME)}&target=clash`);
    const distLink = linkRes.json?.data?.link || '';
    const feedUrl = linkRes.json?.data?.feedUrl || '';
    ok('/api/link 返回分发链接', !!distLink, distLink.replace(BASE, ''));
    ok('分发链接用派生密钥而非管理令牌', distLink.includes('ft=') && !distLink.includes(TOKEN));
    ok('返回 feed 地址', !!feedUrl, feedUrl.replace(BASE, ''));

    const feed2 = await fetch(feedUrl);
    const feedText = await feed2.text();
    ok('派生密钥可拉取 feed', feed2.ok, `HTTP ${feed2.status} · ${feedText.length} 字节`);
    ok('feed 声明节点数', Number(feed2.headers.get('X-SubPilot-Nodes')) > 0, feed2.headers.get('X-SubPilot-Nodes'));

    const feedBad = await fetch(`${feedUrl.split('?')[0]}?ft=deadbeefdeadbeefdeadbeefdeadbeef`);
    ok('错误分发密钥被拒', feedBad.status === 403, `HTTP ${feedBad.status}`);

    const dl = await fetch(`${BASE}/download/${encodeURIComponent(SUB_NAME)}?target=clash&ft=${linkRes.json?.data?.feedKey}`);
    ok('/download 用分发密钥可访问', dl.status !== 403, `HTTP ${dl.status}`);

    const dlBad = await fetch(`${BASE}/download/${encodeURIComponent(SUB_NAME)}?target=clash&ft=nope`);
    ok('/download 用错误密钥返回 403', dlBad.status === 403, `HTTP ${dlBad.status}`);

    const dlAdmin = await fetch(`${BASE}/download/${encodeURIComponent(SUB_NAME)}?target=clash&token=${TOKEN}`);
    ok('/download 仍可用管理令牌（排障通道）', dlAdmin.status !== 403, `HTTP ${dlAdmin.status}`);

    // 8. 转换委派（无算子 → 透传给 SCE）
    console.log('\n[6] 转换委派给 SubConverter-Extended');
    const tq = `token=${encodeURIComponent(TOKEN)}`;
    const passthrough = await fetch(
        `${BASE}/sub?target=clash&url=${encodeURIComponent('https://example.com/not-exist')}&${tq}`,
    );
    const passText = await passthrough.text();
    ok(
        '透传路径真实调用了 SCE（错误信息来自后端）',
        /转换后端|Invalid|无效|not found|HTTP/i.test(passText),
        `HTTP ${passthrough.status} · ${passText.slice(0, 120)}`,
    );

    // 9. 转换（本地内容 + 算子 → feed 中转）
    console.log('\n[7] 本地处理 + feed 中转');
    const conv = await fetch(`${BASE}/sub?target=clash&sub=${encodeURIComponent(SUB_NAME)}&${tq}`);
    const convText = await conv.text();
    console.log(`    处理方式：${conv.headers.get('X-SubPilot-Processed')}`);
    ok(
        '本地处理路径已启用',
        conv.headers.get('X-SubPilot-Processed') === 'local',
        `X-SubPilot-Processed=${conv.headers.get('X-SubPilot-Processed')}`,
    );
    if (conv.ok) {
        ok('转换成功返回配置', convText.length > 100, `${convText.length} 字节`);
    } else {
        // SCE 无法回连 127.0.0.1，本地环境必然失败；把原因打出来而不是假装通过
        console.log(`    ⚠ SCE 无法回连本地 feed（本地开发固有限制）：${convText.slice(0, 160)}`);
    }

    // 10. 分享码
    console.log('\n[8] 分享码');
    const share = await req('/api/shares', {
        method: 'POST',
        body: JSON.stringify({ type: 'sub', name: SUB_NAME, options: { kind: 'days', days: 7 } }),
    });
    ok('生成分享码', share.res.ok && share.json?.data?.code, share.json?.data?.code?.slice(0, 10));
    const code = share.json?.data?.code;
    const shareBad = await fetch(`${BASE}/share/sub/${encodeURIComponent(SUB_NAME)}?code=wrong`);
    ok('错误分享码返回 403', shareBad.status === 403, `HTTP ${shareBad.status}`);
    const shareOk = await fetch(`${BASE}/share/sub/${encodeURIComponent(SUB_NAME)}?code=${code}&target=clash`);
    ok('正确分享码可访问', shareOk.status !== 403, `HTTP ${shareOk.status}`);

    // 11. 统计
    console.log('\n[9] 拉取统计');
    const stats = await req('/api/stats');
    ok('统计接口可用', stats.res.ok, `总拉取 ${stats.json?.data?.total}`);

    // 12. 文件
    console.log('\n[10] 文件');
    const f = await req('/api/files', {
        method: 'POST',
        body: JSON.stringify({ name: '__verify__.yaml', source: 'local', content: 'proxies: []' }),
    });
    ok('创建文件', f.res.ok, `HTTP ${f.res.status}`);
    const fBad = await req('/api/files', {
        method: 'POST',
        body: JSON.stringify({ name: '__verify__.exe', source: 'local', content: 'x' }),
    });
    ok('非法扩展名被拒', fBad.res.status === 400, `HTTP ${fBad.res.status}`);
    await req('/api/file/__verify__.yaml', { method: 'DELETE' });

    // 12b. 成品快照
    console.log('\n[10b] 成品快照');
    const CV = '__verify_conv__';
    await req(`/api/converted/${encodeURIComponent(CV)}`, { method: 'DELETE' });
    const cvPost = await req('/api/converted', {
        method: 'POST',
        body: JSON.stringify({ name: CV, target: 'clash', template: '', content: 'proxies: []' }),
    });
    ok('创建成品返回最新列表', cvPost.res.status === 201 && Array.isArray(cvPost.json?.data), `HTTP ${cvPost.res.status}`);
    ok(
        '列表不回传内容只回 size',
        (cvPost.json?.data || []).every((c) => c.content === undefined && typeof c.size === 'number'),
    );
    const cvGet = await req(`/api/converted/${encodeURIComponent(CV)}`);
    ok('按名称取回成品内容', cvGet.json?.data?.content === 'proxies: []');
    const cvOverwrite = await req('/api/converted', {
        method: 'POST',
        body: JSON.stringify({ name: CV, target: 'singbox', template: '', content: '{"outbounds":[]}' }),
    });
    ok('同名保存是覆盖而非报错', cvOverwrite.res.status === 201, `HTTP ${cvOverwrite.res.status}`);
    const cvList = await req('/api/converted');
    ok('覆盖后 target 已更新', (cvList.json?.data || []).some((c) => c.name === CV && c.target === 'singbox'));
    const cvEmpty = await req('/api/converted', {
        method: 'POST',
        body: JSON.stringify({ name: '__verify_empty__', content: '' }),
    });
    ok('空内容成品被拒', cvEmpty.res.status === 400, cvEmpty.json?.message || '');
    const cvDel = await req(`/api/converted/${encodeURIComponent(CV)}`, { method: 'DELETE' });
    ok('删除成品返回最新列表', cvDel.res.ok && !(cvDel.json?.data || []).some((c) => c.name === CV));

    // ---- 破坏性断言守门 ----
    // 这个脚本会写假 AI 密钥、假 TG token，还会轮换分发密钥。
    // 用户一旦开始真实使用（存在非临时数据），这些动作会覆盖真实配置、
    // 让已发出的分发链接全部失效 —— 而 AI key / TG token 只下发掩码，
    // 覆盖之后无法还原。所以默认只在「干净环境」下跑写入类断言；
    // 确实要强制跑就设 VERIFY_FORCE_WRITE=1。
    const preSubs = (await req('/api/subs')).json?.data || [];
    const preCols = (await req('/api/collections')).json?.data || [];
    const preFiles = (await req('/api/files')).json?.data || [];
    const realCount = [...preSubs, ...preCols, ...preFiles].filter(
        (x) => !String(x.name || '').startsWith('__verify'),
    ).length;
    const WRITE_OK = process.env.VERIFY_FORCE_WRITE === '1' || realCount === 0;
    if (!WRITE_OK) {
        console.log(`  ~ 检测到 ${realCount} 项真实数据，跳过写入类断言（AI 密钥 / 分发密钥轮换 / TG 配置）`);
    }

    // 13. 设置与密钥遮蔽
    console.log('\n[11] 设置');
    const st = await req('/api/settings');
    ok('API Key 不回显明文', st.json?.data?.ai?.apiKey === undefined, JSON.stringify(st.json?.data?.ai));
    ok('返回 hasApiKey 标记', typeof st.json?.data?.ai?.hasApiKey === 'boolean');
    if (WRITE_OK) {
    await req('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ ai: { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-secret-1234567890' } }),
    });
    const stW = await req('/api/settings');
    ok('写入后 hasApiKey 为真', stW.json?.data?.ai?.hasApiKey === true);
    // 留空不覆盖
    await req('/api/settings', { method: 'POST', body: JSON.stringify({ ai: { model: 'changed-model' } }) });
    const st2 = await req('/api/settings');
    ok('留空不清空已存密钥', st2.json?.data?.ai?.hasApiKey === true);
    await req('/api/settings', { method: 'POST', body: JSON.stringify({ ai: { baseUrl: '', model: '', apiKey: '' } }) });
    }

    // 14. 备份
    console.log('\n[12] 备份导出');
    const bk = await req('/api/backup/export');
    ok('导出备份', bk.json?.data?.app === 'SubPilot', `${(bk.json?.data?.subs || []).length} 个订阅`);
    ok('备份不含凭据', !JSON.stringify(bk.json?.data?.settings || {}).includes('sk-secret'), '');

    // 15. 密钥轮换
    console.log('\n[13] 分发密钥轮换');
    if (WRITE_OK) {
    const beforeRotate = await fetch(feedUrl);
    ok('轮换前 feed 可用', beforeRotate.ok, `HTTP ${beforeRotate.status}`);
    await req('/api/feedkey/rotate', { method: 'POST' });
    const afterRotate = await fetch(feedUrl);
    ok('轮换后旧链接立即失效', afterRotate.status === 403, `HTTP ${afterRotate.status}`);
    const newLink = await req(`/api/link?kind=sub&name=${encodeURIComponent(SUB_NAME)}`);
    const afterNew = await fetch(newLink.json?.data?.feedUrl || '');
    ok('轮换后新链接可用', afterNew.ok, `HTTP ${afterNew.status}`);
    } else {
    const linkKeep = await req(`/api/link?kind=sub&name=${encodeURIComponent(SUB_NAME)}`);
    ok('分发链接可生成（未轮换）', !!linkKeep.json?.data?.feedUrl);
    const feedKeep = await fetch(linkKeep.json?.data?.feedUrl || '');
    ok('分发链接可直接拉取', feedKeep.ok, `HTTP ${feedKeep.status}`);
    }

    // 16. Telegram 推送
    console.log('\n[14] Telegram 推送');
    const tg0 = await req('/api/telegram/config');
    ok('TG 配置接口可用', tg0.res.ok, `HTTP ${tg0.res.status}`);
    ok('TG 配置不回显明文 token', tg0.json?.data?.token === undefined, JSON.stringify(tg0.json?.data));
    ok('TG 配置返回 tokenSet 标记', typeof tg0.json?.data?.tokenSet === 'boolean');

    // TG 配置全局只有一份。下面的写入类断言会用假 token 覆盖真实配置、
    // 再把推送目标清空 —— 而 token 只下发掩码，覆盖之后没法还原。
    // 所以检测到已有真实 token 时，只跑不写库的断言（下面三条校验都发生在写库之前）。
    const tgConfigured = !!tg0.json?.data?.tokenSet;
    const tgSkipWrite = tgConfigured || !WRITE_OK;

    const tgBadChat = await req('/api/telegram/config', {
        method: 'POST',
        body: JSON.stringify({ chatIds: '@@bad id!' }),
    });
    ok('非法推送 ID 被拒', tgBadChat.res.status === 400, tgBadChat.json?.message || '');

    const tgBadKind = await req('/api/telegram/config', {
        method: 'POST',
        body: JSON.stringify({ targets: [{ kind: 'nope', name: 'x' }] }),
    });
    ok('非法推送类型被拒', tgBadKind.res.status === 400, tgBadKind.json?.message || '');

    const tgBadLink = await req('/api/telegram/config', {
        method: 'POST',
        body: JSON.stringify({ linkType: 'not-a-target' }),
    });
    ok('非法链接格式被拒', tgBadLink.res.status === 400, tgBadLink.json?.message || '');

    const TG_TOKEN = '123456789:AAFakeTokenForVerifyOnly0123456789';
    if (tgSkipWrite) {
        console.log('  ~ 已有真实配置 / 数据，跳过 TG 写入类断言（不覆盖现有配置）');
    } else {
    const tgSave = await req('/api/telegram/config', {
        method: 'POST',
        body: JSON.stringify({
            token: TG_TOKEN,
            chatIds: '12345678, @my_channel，999',
            targets: [
                { kind: 'sub', name: SUB_NAME },
                { kind: 'sub', name: SUB_NAME },
            ],
            linkType: 'clash',
            autoPush: true,
        }),
    });
    const tgCfg = tgSave.json?.data || {};
    ok('保存 TG 配置成功', tgSave.res.ok, `HTTP ${tgSave.res.status}`);
    ok('只回 token 掩码不回明文', !!tgCfg.tokenMask && !JSON.stringify(tgCfg).includes('AAFakeToken'), tgCfg.tokenMask);
    ok('推送 ID 归一化为逗号串', tgCfg.chatIds === '12345678,my_channel,999', tgCfg.chatIds);
    ok('推送 ID 计数正确', tgCfg.chatCount === 3, String(tgCfg.chatCount));
    ok('重复推送目标被去重', (tgCfg.targets || []).length === 1, `${(tgCfg.targets || []).length} 项`);

    const stTg = await req('/api/settings');
    ok('/api/settings 不泄漏 TG token', !JSON.stringify(stTg.json?.data?.telegram || {}).includes('AAFakeToken'));
    ok('/api/settings 仍返回 TG 掩码', !!stTg.json?.data?.telegram?.tokenMask);

    const bkTg = await req('/api/backup/export');
    ok('备份导出不泄漏 TG token', !JSON.stringify(bkTg.json || {}).includes('AAFakeToken'));

    const tgMissing = await req('/api/telegram/push', {
        method: 'POST',
        body: JSON.stringify({ targets: [{ kind: 'sub', name: '__no_such__' }] }),
    });
    ok('推送不存在的目标报错', tgMissing.res.status === 404, tgMissing.json?.message || '');

    const tgPush = await req('/api/telegram/push', { method: 'POST', body: JSON.stringify({}) });
    ok(
        '假 token 推送失败并汇总原因',
        tgPush.res.status === 502 && /推送失败/.test(tgPush.json?.message || ''),
        (tgPush.json?.message || '').replace(/\n/g, ' | ').slice(0, 160),
    );
    const tgAfter = await req('/api/telegram/config');
    ok('lastPush 记录失败结果', tgAfter.json?.data?.lastPush?.ok === false, JSON.stringify(tgAfter.json?.data?.lastPush));
    ok('lastPush 覆盖全部推送 ID', tgAfter.json?.data?.lastPush?.chats === 3, String(tgAfter.json?.data?.lastPush?.chats));

    // 文件没有派生密钥通道，走分享码；推两次必须复用同一条，否则 900 条上限会被慢慢吃光
    await req('/api/files', {
        method: 'POST',
        body: JSON.stringify({ name: '__verify_tg__.yaml', source: 'local', content: 'proxies: []' }),
    });
    const sharesBefore = (await req('/api/shares')).json?.data?.length ?? 0;
    await req('/api/telegram/push', {
        method: 'POST',
        body: JSON.stringify({ targets: [{ kind: 'file', name: '__verify_tg__.yaml' }] }),
    });
    await req('/api/telegram/push', {
        method: 'POST',
        body: JSON.stringify({ targets: [{ kind: 'file', name: '__verify_tg__.yaml' }] }),
    });
    const sharesAfter = (await req('/api/shares')).json?.data?.length ?? 0;
    ok('文件推送复用已有分享码', sharesAfter - sharesBefore === 1, `${sharesBefore} → ${sharesAfter}`);

    // 清理 TG 配置与临时文件
    await req('/api/telegram/config', { method: 'POST', body: JSON.stringify({ targets: [], autoPush: false }) });
    await req('/api/file/__verify_tg__.yaml', { method: 'DELETE' });
    }

    // 清理
    await req(`/api/sub/${encodeURIComponent(SUB_NAME)}`, { method: 'DELETE' });
    if (code) await req(`/api/shares?code=${code}`, { method: 'DELETE' });

    console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==\n`);
    process.exit(fail ? 1 : 0);
}

main().catch((e) => {
    console.error('验证脚本异常：', e);
    process.exit(1);
});
