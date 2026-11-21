
// ======================================================
// Cloudflare Worker - Typecho 反向代理
// 前台伪静态 / 后台直通 / Action 路由 / Cookie 修复
// 修复：Typecho 内嵌脚本将代理站内链接错误设置为 target="_blank"
// ======================================================


// ==================== 1. 基本配置 ====================

// 上游网站域名，不带协议
const upstream = '你的id.pages-perso.free.fr';

// 移动端上游域名
const upstream_mobile = '你的id.pages-perso.free.fr';

// 上游网站路径
const upstream_path = '/';

// 是否使用 HTTPS
const https = true;

// 是否禁用全站缓存
const disable_cache = false;

// 禁止访问的国家
const blocked_region = [];

// 禁止访问的 IP
const blocked_ip_address = [
    '0.0.0.0',
    '127.0.0.1'
];


// ==================== 2. Worker 入口 ====================

addEventListener('fetch', event => {
    event.respondWith(fetchAndApply(event.request));
});


async function fetchAndApply(request) {
    const originalUrl = new URL(request.url);

    const customOrigin = originalUrl.origin;
    const customHost = originalUrl.host;
    const originalPath = originalUrl.pathname;

    const region = (
        request.headers.get('cf-ipcountry') || ''
    ).toUpperCase();

    const ip = request.headers.get('cf-connecting-ip') || '';
    const userAgent = request.headers.get('user-agent') || '';


    // ==================== 3. 地区及 IP 限制 ====================

    if (blocked_region.includes(region)) {
        return new Response('Access denied: Region blocked.', {
            status: 403
        });
    }

    if (blocked_ip_address.includes(ip)) {
        return new Response('Access denied: IP blocked.', {
            status: 403
        });
    }


    // ==================== 4. 选择上游网站 ====================

    const upstreamDomain = device_status(userAgent)
        ? upstream
        : upstream_mobile;


    // ==================== 5. 判断访问路径类型 ====================

    // Typecho 后台
    const isAdmin = /^\/admin(?:\/|$)/i.test(originalPath);

    // 是否包含 index.php
    const isIndexPhp = /^\/index\.php(?:\/|$)/i.test(originalPath);

    // Typecho Action：/action/... 或 /index.php/action/...
    const isTypechoAction =
        /^\/(?:index\.php\/)?action(?:\/|$)/i.test(originalPath);

    // 后台请求
    const isBackendRequest = isAdmin || isTypechoAction;

    // 首页
    const isRoot = originalPath === '/';

    // 静态资源
    const staticExtensions =
        /\.(?:css|js|mjs|map|jpg|jpeg|png|gif|webp|avif|svg|ico|bmp|tif|tiff|woff|woff2|ttf|otf|eot|mp4|webm|mp3|ogg|wav)$/i;

    const isStatic = staticExtensions.test(originalPath);


    // ==================== 6. 构造上游 URL ====================

    const targetUrl = new URL(originalUrl.toString());

    targetUrl.protocol = https ? 'https:' : 'http:';
    targetUrl.hostname = upstreamDomain;
    targetUrl.port = '';

    const prefix = upstream_path === '/'
        ? ''
        : upstream_path.replace(/\/+$/, '');


    // ==================== 7. Typecho 路由处理 ====================

    if (isAdmin || isRoot || isStatic) {

        // 后台、首页、静态资源保留原始路径
        targetUrl.pathname = prefix + originalPath;

    } else if (isIndexPhp) {

        // 已经包含 index.php 的路径，不重复添加
        targetUrl.pathname = prefix + originalPath;

    } else if (isTypechoAction) {

        // Action 路由补充 index.php
        // 例如 /action/logout
        // 转发为 /index.php/action/logout
        targetUrl.pathname =
            prefix + '/index.php' + originalPath;

    } else {

        // 前台普通路径使用伪静态模拟
        targetUrl.pathname =
            prefix + '/index.php' + originalPath;
    }

    // 保留原始查询参数，包括 Action 安全令牌
    targetUrl.search = originalUrl.search;

    // 仅对前台评论 POST 请求跳过 Typecho 的来源页校验
    // 保留其他评论安全检查和反垃圾保护
    const isFrontendCommentPost =
        request.method === 'POST' &&
        /\/comment\/?$/i.test(originalPath);

    if (isFrontendCommentPost) {
        targetUrl.searchParams.set('checkReferer', 'false');
    }


    // ==================== 8. 请求头处理 ====================

    const headers = new Headers(request.headers);

    // Host 由 fetch 根据目标 URL 自动处理
    headers.delete('host');

    headers.set('X-Forwarded-Host', customHost);
    headers.set(
        'X-Forwarded-Proto',
        originalUrl.protocol.replace(':', '')
    );

    if (ip) {
        headers.set('X-Forwarded-For', ip);
    }


    // ==================== Referer 处理 ====================

    const originalReferer = headers.get('Referer');

    // 退出登录请求
    const isLogoutAction =
        /^\/(?:index\.php\/)?action\/logout\/?$/i.test(originalPath);

    if (originalReferer) {
        try {
            const refererUrl = new URL(originalReferer);

            if (
                refererUrl.host.toLowerCase() ===
                customHost.toLowerCase()
            ) {

                // --------------------------------------
                // A. 退出登录请求专用处理
                // --------------------------------------

                if (isLogoutAction) {

                    // 转换协议和域名
                    refererUrl.protocol = targetUrl.protocol;
                    refererUrl.host = upstreamDomain;

                    const refererPath = refererUrl.pathname;

                    // 首页保持根路径
                    if (refererPath === '/') {

                        refererUrl.pathname = prefix + '/';

                    // 已经包含 index.php，不重复添加
                    } else if (
                        /^\/index\.php(?:\/|$)/i.test(refererPath)
                    ) {

                        refererUrl.pathname =
                            prefix + refererPath;

                    // 后台及 Action 路径保持原样
                    } else if (
                        /^\/(?:admin|action)(?:\/|$)/i.test(refererPath)
                    ) {

                        refererUrl.pathname =
                            prefix + refererPath;

                    // 普通前台文章、分类、标签等路径
                    // 补充 index.php，与上游实际路由保持一致
                    } else {

                        refererUrl.pathname =
                            prefix + '/index.php' + refererPath;
                    }

                    headers.set('Referer', refererUrl.toString());

                }

                // --------------------------------------
                // B. 评论请求专用处理
                // --------------------------------------

                else if (isFrontendCommentPost) {

                    // 评论请求：转换为上游页面地址
                    refererUrl.protocol = targetUrl.protocol;
                    refererUrl.host = upstreamDomain;

                    refererUrl.pathname =
                        prefix + '/index.php' + refererUrl.pathname;

                    headers.set('Referer', refererUrl.toString());

                }

                // --------------------------------------
                // C. 其他请求维持原来的处理方式
                // --------------------------------------

                else {

                    refererUrl.protocol = targetUrl.protocol;
                    refererUrl.host = upstreamDomain;

                    headers.set('Referer', refererUrl.toString());
                }
            }

        } catch (error) {
            // 无法解析时保留原 Referer
        }
    }


    // ==================== Origin 处理 ====================

    const originalOrigin = headers.get('Origin');

    if (originalOrigin) {
        try {
            const originUrl = new URL(originalOrigin);

            if (
                originUrl.host.toLowerCase() ===
                customHost.toLowerCase()
            ) {
                headers.set('Origin', targetUrl.origin);
            }

        } catch (error) {
            // 无法解析时保留原 Origin
        }
    }


    // ==================== 9. 请求 Body 处理 ====================

    const requestInit = {
        method: request.method,
        headers: headers,
        redirect: 'manual'
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {

        // 登录 POST 特殊处理：如果表单中存在空 referer，则补充上游后台地址
        if (
            request.method === 'POST' &&
            /^\/(?:index\.php\/)?action\/login\/?$/i.test(originalPath)
        ) {
            const contentType = headers.get('content-type') || '';

            if (contentType.includes('application/x-www-form-urlencoded')) {
                const bodyText = await request.clone().text();
                const params = new URLSearchParams(bodyText);

                if (params.has('referer') && !params.get('referer')) {
                    params.set('referer', targetUrl.origin + '/admin/');
                    requestInit.body = params.toString();

                    // Body 已重新生成，删除旧长度
                    headers.delete('content-length');

                } else {
                    requestInit.body = request.body;
                }

            } else {
                requestInit.body = request.body;
            }

        } else {
            requestInit.body = request.body;
        }
    }


    // ==================== 10. 请求上游 ====================

    let upstreamResponse;

    // 评论请求诊断：不记录 Cookie、令牌或评论正文
    if (
        request.method === 'POST' &&
        /\/comment\/?$/i.test(originalPath)
    ) {
        console.log(
            '[TYPECHO COMMENT DEBUG]',
            JSON.stringify({
                publicUrl: request.url,
                upstreamUrl: targetUrl.toString(),
                incomingReferer: request.headers.get('Referer'),
                forwardedReferer: headers.get('Referer'),
                incomingOrigin: request.headers.get('Origin'),
                forwardedOrigin: headers.get('Origin')
            })
        );
    }

    try {
        upstreamResponse = await fetch(
            targetUrl.toString(),
            requestInit
        );

    } catch (error) {
        return new Response(
            'Upstream connection error: ' + error.message,
            { status: 502 }
        );
    }


    // ==================== 11. 响应头处理 ====================

    const responseHeaders = new Headers(upstreamResponse.headers);


    // ==================== 12. Cookie 处理 ====================

    // 获取全部 Set-Cookie
    const setCookies = getSetCookieHeaders(upstreamResponse.headers);

    // 删除原始 Set-Cookie
    responseHeaders.delete('set-cookie');

    // 转换 Cookie Domain 并重新添加
    for (const cookie of setCookies) {
        const rewrittenCookie = rewriteSetCookieDomain(
            cookie,
            upstreamDomain
        );

        responseHeaders.append('Set-Cookie', rewrittenCookie);
    }


    // ==================== 13. 重定向处理 ====================

    const location = responseHeaders.get('Location');

    if (location) {
        try {
            const redirectUrl = new URL(location, targetUrl.toString());

            // 将上游域名替换为代理域名
            if (
                redirectUrl.hostname.toLowerCase() ===
                upstreamDomain.toLowerCase()
            ) {
                redirectUrl.protocol = originalUrl.protocol;
                redirectUrl.host = customHost;
            }

            const redirectIsAdmin =
                /^\/admin(?:\/|$)/i.test(redirectUrl.pathname);

            const redirectIsAction =
                /^\/(?:index\.php\/)?action(?:\/|$)/i.test(
                    redirectUrl.pathname
                );

            // 后台请求或跳往后台的请求不隐藏 index.php
            if (
                !isBackendRequest &&
                !redirectIsAdmin &&
                !redirectIsAction
            ) {
                redirectUrl.pathname =
                    redirectUrl.pathname.replace(
                        /^\/index\.php(?=\/)/i,
                        ''
                    ) || '/';
            }

            responseHeaders.set('Location', redirectUrl.toString());

        } catch (error) {
            // 无法解析的 Location 保持原样
        }
    }


    // ==================== 14. 缓存设置 ====================

    // 后台和 Action 一律不缓存
    if (isBackendRequest || disable_cache) {
        responseHeaders.set(
            'Cache-Control',
            'no-store, no-cache, must-revalidate'
        );

        responseHeaders.set('Pragma', 'no-cache');
        responseHeaders.set('Expires', '0');
    }


    // ==================== 15. 安全响应头处理 ====================

    responseHeaders.delete('content-security-policy');
    responseHeaders.delete('content-security-policy-report-only');
    responseHeaders.delete('clear-site-data');


    // ==================== 16. WebSocket 处理 ====================

    if (
        request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
    ) {
        return upstreamResponse;
    }


    // ==================== 17. 重定向响应直接返回 ====================

    // 3xx 响应不修改正文，保留已经处理过的 Location 和 Set-Cookie
    if (
        upstreamResponse.status >= 300 &&
        upstreamResponse.status < 400
    ) {
        return new Response(upstreamResponse.body, {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: responseHeaders
        });
    }


    // ==================== 18. 响应内容处理 ====================

    const contentType = responseHeaders.get('content-type') || '';
    const isHtml = contentType.includes('text/html');

    const isTextContent =
        isHtml ||
        contentType.includes('text/css') ||
        contentType.includes('javascript') ||
        contentType.includes('json');

    if (isTextContent) {
        let text = await upstreamResponse.text();

        if (isBackendRequest) {

            // 后台：替换域名，不隐藏 index.php
            text = replaceDomain(
                text,
                upstreamDomain,
                customOrigin
            );

            if (isHtml) {

                // 修复 Typecho 后台内嵌脚本的站内链接打开方式
                text = rewriteBackendHtml(
                    text,
                    upstreamDomain,
                    customHost,
                    customOrigin
                );
            }

        } else {

            // 前台：替换域名并隐藏 index.php
            text = rewriteFrontend(
                text,
                upstreamDomain,
                customOrigin
            );
        }

        // 内容已经重新生成，删除旧内容长度及编码信息
        responseHeaders.delete('content-length');
        responseHeaders.delete('content-encoding');
        responseHeaders.delete('etag');
        responseHeaders.delete('content-md5');

        return new Response(text, {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: responseHeaders
        });
    }


    // ==================== 19. 其他资源直接透传 ====================

    return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders
    });
}


// ==================== 20. 获取全部 Set-Cookie ====================

function getSetCookieHeaders(headers) {

    // 优先使用标准 getSetCookie()
    if (typeof headers.getSetCookie === 'function') {
        return headers.getSetCookie();
    }

    // 兼容部分旧环境
    if (typeof headers.getAll === 'function') {
        try {
            return headers.getAll('Set-Cookie');
        } catch (error) {
            // 继续使用下面的兼容方案
        }
    }

    // 最后兼容合并后的 Set-Cookie
    const combined = headers.get('Set-Cookie');

    if (!combined) {
        return [];
    }

    // 按 Cookie 起始位置分割，避免把 Expires 日期中的逗号误当成分隔符
    return combined.split(/,(?=\s*[^;,\s]+=)/g);
}


// ==================== 21. Cookie Domain 转换 ====================

function rewriteSetCookieDomain(cookie, upstreamDomain) {
    const escapedDomain = escapeRegExp(upstreamDomain);

    const domainRegex = new RegExp(
        ';\\s*domain\\s*=\\s*\.?' + escapedDomain + '(?=;|$)',
        'i'
    );

    // 删除匹配上游域名的 Domain 属性，让浏览器保存为代理域名的 Host-only Cookie
    return cookie.replace(domainRegex, '');
}


// ==================== 22. 后台 HTML 适配 ====================

function rewriteBackendHtml(html, upstreamDomain, customHost, customOrigin) {
    let result = html;

    // 同步替换内嵌脚本中的普通域名字符串
    result = result.split(upstreamDomain).join(customHost);

    // 同步替换内嵌 JavaScript 正则中的转义域名
    const escapedUpstream = escapeRegexForJavaScript(upstreamDomain);
    const escapedCustom = escapeRegexForJavaScript(customHost);

    result = result.split(escapedUpstream).join(escapedCustom);

    // 修复 Typecho 1.3.0 通知 Cookie 的清理作用域
    result = result.replace(
        /<script\b[^>]*>[\s\S]*?<\/script>/gi,
        function (script) {
            if (script.indexOf('__typecho_notice') === -1) {
                return script;
            }

            return script.replace(
                /(\bdomain\s*=\s*)(['"])[^'"]+\2/i,
                '$1null'
            );
        }
    );


    // 替换 Typecho 后台脚本中统一添加 target="_blank" 的逻辑
    const targetSetterPattern =
        /t\.attr\(\s*(['"])target\1\s*,\s*(['"])_blank\2\s*\)\s*\.attr\(\s*(['"])rel\3\s*,\s*(['"])noopener noreferrer\4\s*\)\s*;?/gi;

    const targetSetterReplacement = `
        (function () {
            var linkElement = document.createElement('a');
            linkElement.href = href || '';

            if (
                linkElement.host &&
                linkElement.host.toLowerCase() !== window.location.host.toLowerCase()
            ) {
                t.attr('target', '_blank')
                    .attr('rel', 'noopener noreferrer');
            } else {
                t.removeAttr('target');
            }
        })();
    `;

    result = result.replace(
        targetSetterPattern,
        targetSetterReplacement
    );

    // 处理 HTML 中原本就存在的 target="_blank"
    result = fixAdminLinks(result);

    return result;
}


// ==================== 23. 后台静态链接修复 ====================

function fixAdminLinks(html) {
    // 兼容双引号、单引号和无引号
    return html.replace(
        /(<a\b[^>]*?)\s+target\s*=\s*(?:"_blank"|'_blank'|_blank)/gi,
        '$1'
    );
}


// ==================== 24. 移动端识别 ====================

function device_status(userAgent) {
    const mobileAgents = [
        'Android',
        'iPhone',
        'SymbianOS',
        'Windows Phone',
        'iPad',
        'iPod'
    ];

    const ua = userAgent.toLowerCase();

    return !mobileAgents.some(agent =>
        ua.includes(agent.toLowerCase())
    );
}


// ==================== 25. 正则转义工具 ====================

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


// 用于替换 JavaScript 正则字面量中的域名
function escapeRegexForJavaScript(value) {
    return value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}


// ==================== 26. 域名替换 ====================

function replaceDomain(text, upstreamDomain, customOrigin) {
    const escapedDomain = escapeRegExp(upstreamDomain);

    // 普通 URL 及 JSON 字符串中的域名部分
    const domainRegex = new RegExp(
        escapedDomain,
        'gi'
    );

    const customHost = new URL(customOrigin).host;

    text = text.replace(domainRegex, customHost);

    // 统一绝对 URL 的协议和域名为代理 Origin
    const escapedCustomHost = escapeRegExp(customHost);

    const absoluteUrlRegex = new RegExp(
        'https?:\\/\\/' + escapedCustomHost,
        'gi'
    );

    text = text.replace(absoluteUrlRegex, customOrigin);

    return text;
}


// ==================== 27. 前台 URL 处理 ====================

function rewriteFrontend(text, upstreamDomain, customOrigin) {

    // 首先替换上游域名
    text = replaceDomain(
        text,
        upstreamDomain,
        customOrigin
    );

    // 只隐藏前台链接中的 index.php
    // /index.php/archive/1 -> /archive/1
    text = text.replace(
        /\/index\.php(?=\/)/gi,
        ''
    );

    return text;
}
