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
    // Temporary chat: these conversations are not saved to history and do not
    // train the account. The agents send hundreds of messages, so anything
    // else would bury the user's real chats.
    url: 'https://chatgpt.com/?temporary-chat=true',
    // Rotate to a fresh chat by navigating rather than by clicking "New chat":
    // that button opens a normal, saved conversation and would defeat the
    // temporary-chat flag above.
    freshChatByNavigation: true,
    partition: 'persist:chatgpt',
    authCookies: ['__Secure-next-auth.session-token', '__Secure-next-auth.callback-url', '_account'],
    primaryAuthCookie: '__Secure-next-auth.session-token',
    cookieDomains: ['chatgpt.com', 'openai.com'],
    newChatLabel: /\bnew chat\b/i,
    loginHint: 'log in to ChatGPT in tab A',
  },
};
