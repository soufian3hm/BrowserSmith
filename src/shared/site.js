'use strict';
/**
 * The single place the target chat product is defined.
 *
 * Everything else - session partition, cookie sniffing, the webviews, the
 * renderer copy - reads these values instead of naming a product itself, so
 * pointing the app at a different chat UI is a one-file change.
 */

module.exports = {
  SITE: {
    key: 'chatgpt',
    name: 'ChatGPT',
    brand: 'buildgpt',
    url: 'https://chatgpt.com/',
    partition: 'persist:chatgpt',
    authCookies: ['__Secure-next-auth.session-token', '__Secure-next-auth.callback-url', '_account'],
    primaryAuthCookie: '__Secure-next-auth.session-token',
    cookieDomains: ['chatgpt.com', 'openai.com'],
    newChatLabel: /\bnew chat\b/i,
    loginHint: 'log in to ChatGPT in tab A',
  },
};
