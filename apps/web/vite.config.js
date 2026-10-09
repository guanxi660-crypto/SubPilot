import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

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
