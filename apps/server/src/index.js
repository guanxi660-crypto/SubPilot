import { handleRequest, withSecurityHeaders } from './router.js';

export default {
    async fetch(request, env, ctx) {
        return withSecurityHeaders(await handleRequest(request, env, ctx));
    },
};
