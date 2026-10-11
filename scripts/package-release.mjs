// 发布打包：根据当前分支生成对应的分发包。
//
// main 分支 → subpilot-<版本>-worker.zip  (Cloudflare Worker 部署包)
// dev  分支 → subpilot-<版本>-node.zip    (自建部署 Node / Docker)
//
// 用法：node scripts/package-release.mjs      （先 npm run build）
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const OUT = join(ROOT, 'release');
const TMP = join(OUT, '.build');

// 检测当前分支
let BRANCH = '';
try {
    BRANCH = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
    BRANCH = 'unknown';
}

if (!existsSync(join(ROOT, 'apps/web/dist/index.html'))) {
    console.error('✗ 缺少 apps/web/dist —— 先跑 npm run build');
    process.exit(1);
}

const serverPkg = JSON.parse(readFileSync(join(ROOT, 'apps/server/package.json'), 'utf8'));
if (serverPkg.version !== VERSION) {
    console.error(`✗ 版本不一致：根 ${VERSION} / server ${serverPkg.version}`);
    process.exit(1);
}
const webPkg = JSON.parse(readFileSync(join(ROOT, 'apps/web/package.json'), 'utf8'));
if (webPkg.version !== VERSION) {
    console.error(`✗ 版本不一致：根 ${VERSION} / web ${webPkg.version}`);
    process.exit(1);
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });

const copy = (from, to) => cpSync(join(ROOT, from), join(TMP, to), { recursive: true });
const commonFiles = ['README.md', 'LICENSE', 'NOTICE'];

// ---- Worker 包（main 分支）----
if (BRANCH === 'main') {
    const top = `subpilot-${VERSION}-worker`;
    copy('apps/server/src', `${top}/apps/server/src`);
    copy('apps/server/package.json', `${top}/apps/server/package.json`);
    copy('apps/server/wrangler.jsonc', `${top}/apps/server/wrangler.jsonc`);
    copy('apps/web/dist', `${top}/apps/web/dist`);
    for (const f of commonFiles) if (existsSync(join(ROOT, f))) copy(f, `${top}/${f}`);
    writeFileSync(
        join(TMP, top, '部署说明.txt'),
        `SubPilot ${VERSION} · Cloudflare Worker 部署包
================================================

1) 安装依赖并登录 wrangler
     cd apps/server
     npm install
     npx wrangler login

2) 创建 KV namespace，把输出的 id 填进 apps/server/wrangler.jsonc
     npx wrangler kv namespace create DATA -c wrangler.jsonc

3) 设置访问令牌（不设置时所有受保护接口一律 401）
     npx wrangler secret put SUBPILOT_TOKEN -c wrangler.jsonc

4) 部署（前端产物已包含在 apps/web/dist）
     npx wrangler deploy -c wrangler.jsonc

注意：
· wrangler.jsonc 里的 name 必须与目标 Worker 一致，否则会新建一个 Worker。
· assets 目录指向 ../web/dist，本包已按该相对结构组织，不要移动目录。
· 转换后端地址在 vars.SUB_BACKEND，也可登录后在「转换」页修改。
· Script Operator 使用 QuickJS WASM 沙箱（quickjs.wasm 已包含在 src/ 中）。
`,
        'utf8',
    );
    console.log(`✓ Worker 包准备完成（main 分支）`);
}

// ---- Node 包（dev 分支）----
if (BRANCH === 'dev') {
    const top = `subpilot-${VERSION}-node`;
    copy('apps/server/src', `${top}/apps/server/src`);
    copy('apps/server/package.json', `${top}/apps/server/package.json`);
    copy('apps/web/dist', `${top}/apps/web/dist`);
    for (const f of commonFiles) if (existsSync(join(ROOT, f))) copy(f, `${top}/${f}`);

    // Node 适配层 + 部署脚手架
    copy('apps/server/node', `${top}/apps/server/node`);
    copy('package.json', `${top}/package.json`);
    const nodeFiles = ['index.js', 'Dockerfile', 'docker-compose.yml', '.env.example'];
    for (const f of nodeFiles) {
        if (existsSync(join(ROOT, f))) copy(f, `${top}/${f}`);
    }
    // 运行时唯一依赖：yaml
    const yamlSrc = join(ROOT, 'apps/server/node_modules/yaml');
    if (existsSync(yamlSrc)) {
        cpSync(yamlSrc, join(TMP, top, 'apps/server/node_modules/yaml'), { recursive: true });
    } else {
        console.warn('! 未找到 apps/server/node_modules/yaml —— 用户需自行 npm install');
    }
    console.log(`✓ Node 包准备完成（dev 分支）`);
}

if (BRANCH !== 'main' && BRANCH !== 'dev') {
    console.error(`✗ 不支持的分支：${BRANCH}（只支持 main / dev）`);
    process.exit(1);
}

// ---- 压缩 ----
const zip = (dirName) => {
    const src = join(TMP, dirName);
    const dst = join(OUT, `${dirName}.zip`);
    rmSync(dst, { force: true });
    try {
        const winBsdtar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
        const tool = process.platform === 'win32' && existsSync(winBsdtar) ? winBsdtar : 'tar';
        execFileSync(tool, ['-a', '-c', '-f', dst, '-C', TMP, dirName], { stdio: 'inherit' });
    } catch {
        console.warn('! tar 不可用，回退 Compress-Archive');
        execFileSync('powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            `Compress-Archive -Path '${src}' -DestinationPath '${dst}' -Force`,
        ], { stdio: 'inherit' });
    }
    return dst;
};

const list = (dir) => readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile()).map((d) => `${d.name} (${(statSync(join(dir, d.name)).size / 1048576).toFixed(2)} MB)`);

const pkgName = BRANCH === 'main' ? `subpilot-${VERSION}-worker` : `subpilot-${VERSION}-node`;
const built = [pkgName].map(zip);
rmSync(TMP, { recursive: true, force: true });
console.log(`\n== 版本 ${VERSION} (${BRANCH} 分支) 发布包 ==`);
for (const b of list(OUT)) console.log('  ', b);
process.exit(0);