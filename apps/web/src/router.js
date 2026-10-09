import { createRouter, createWebHashHistory } from 'vue-router';
import Login from './views/Login.vue';
import Dashboard from './views/Dashboard.vue';
import Subs from './views/Subs.vue';
import SubEdit from './views/SubEdit.vue';
import Collections from './views/Collections.vue';
import Files from './views/Files.vue';
import Converter from './views/Converter.vue';
import Sync from './views/Sync.vue';
import AIAssistant from './views/AIAssistant.vue';
import Settings from './views/Settings.vue';

// 用 hash 路由：单 Worker 下 assets 的 SPA 回退已开，但 hash 路由省掉服务端
// 对深层路径的 rewrite 依赖，任何静态托管都能直接跑。
export const router = createRouter({
    history: createWebHashHistory(),
    routes: [
        { path: '/', component: Dashboard, meta: { title: '概览' } },
        { path: '/subs', component: Subs, meta: { title: '订阅' } },
        { path: '/subs/edit/:name', component: SubEdit, meta: { title: '编辑订阅' } },
        { path: '/collections', component: Collections, meta: { title: '组合' } },
        { path: '/files', component: Files, meta: { title: '文件' } },
        { path: '/converter', component: Converter, meta: { title: '转换' } },
        { path: '/sync', component: Sync, meta: { title: '同步' } },
        { path: '/ai', component: AIAssistant, meta: { title: 'AI 助手' } },
        { path: '/settings', component: Settings, meta: { title: '设置' } },
        { path: '/login', component: Login },
    ],
});
