import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 构建指纹：注入 __BUILD_ID__ / __BUILD_TIME__，由侧栏底部显示。
//
// 为什么需要：SPA 一旦加载就常驻，部署新版本后**不会自己更新** ——
// 用户会一直看着旧页面，然后以为「改了没生效」。之前排查「编辑订阅页
// 底部还是老样子」就卡在这里：线上产物明明是最新的，用户浏览器里却是几小时前
// 加载的那份。有个可见的构建号，一眼就能判断手上是哪一版。
//
// 容器里构建时没有 .git（.dockerignore 排除了），execSync 会抛错 —— 兜底为 'nogit'。
const buildId = (() => {
    try {
        return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim();
    } catch {
        return 'nogit';
    }
})();
// 形如 2026-10-09 23:20（本地时区），配合 hash 用；只精确到分钟足够
const buildTime = new Date().toLocaleString('sv-SE').slice(0, 16);

// 本地调试：后端由 wrangler dev 跑在 8795（apps/server 下 npm run dev 固定该端口）。
// 改端口时这里要同步改，否则代理 ECONNREFUSED、所有接口回 503。
const API_TARGET = 'http://127.0.0.1:8795';

// 后端按 Origin 判定同源，dev 下前端端口(5173)与后端(8795)不同，
// 需把 Origin 改写为后端地址，否则会被拦成 403。仅影响本地开发代理。
const apiProxy = () => ({
    target: API_TARGET,
    changeOrigin: true,
    headers: { Origin: API_TARGET },
    configure: (proxy) => {
        // 后端没起来时默认回一个裸 500，看不出原因。换成 503 + 明确提示。
        proxy.on('error', (err, _req, res) => {
            const hint =
                err?.code === 'ECONNREFUSED'
                    ? `后端未启动或无响应（${API_TARGET}）。请先运行 npm run dev:server。`
                    : `代理到后端失败（${API_TARGET}）：${err?.message || err}`;
            if (res.writeHead && !res.headersSent) {
                res.writeHead(503, { 'Content-Type': 'application/json;charset=UTF-8' });
                res.end(JSON.stringify({ status: 'failed', message: hint }));
            }
        });
    },
});

export default defineConfig({
    plugins: [vue()],
    // 编译期常量：模板里直接用 __BUILD_ID__ / __BUILD_TIME__
    define: {
        __BUILD_ID__: JSON.stringify(buildId),
        __BUILD_TIME__: JSON.stringify(buildTime),
    },
    server: {
        port: 5175,
        proxy: {
            '/api': apiProxy(),
            '/download': apiProxy(),
            '/feed': apiProxy(),
            '/share': apiProxy(),
            '/sub': apiProxy(),
            '/ai': apiProxy(),
            '/healthz': apiProxy(),
        },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
});
