'use strict';
/**
 * The single place the target chat product AND this product's identity are
 * defined.
 *
 * Everything else - session partition, cookie sniffing, the webviews, the
 * renderer copy, the window title, the application menu - reads these values
 * instead of naming a product itself, so pointing the app at a different chat
 * UI is a one-file change.
 */

// This app. `brand` is also the key the preload exposes the bridge under, so it
// is lowercase and identifier-safe; `product` is what humans read.
const PRODUCT = {
  brand: 'browsersmith',
  product: 'BrowserSmith',
  tagline: 'Four ChatGPT tabs that plan, build, review and audit real projects',
  repo: 'https://github.com/soufian3hm/BrowserSmith',
  issues: 'https://github.com/soufian3hm/BrowserSmith/issues',
  license: 'MIT',
};

// The chat product being driven - NOT this app. Renaming BrowserSmith must
// never rename ChatGPT, so the two live in separate fields.
const SITE_NAME = 'ChatGPT';

module.exports = {
  ...PRODUCT,
  PRODUCT,
  SITE: {
    key: 'chatgpt',
    name: SITE_NAME,
    brand: PRODUCT.brand,
    product: PRODUCT.product,
    repo: PRODUCT.repo,
    issues: PRODUCT.issues,
    license: PRODUCT.license,
    // Temporary chat: these conversations are not saved to history and do not
    // train the account. The agents send hundreds of messages, so anything
    // else would bury the user's real chats.
    url: 'https://chatgpt.com/?temporary-chat=true',
    // Rotate to a fresh chat by navigating rather than by clicking "New chat":
    // that button opens a normal, saved conversation and would defeat the
    // temporary-chat flag above.
    freshChatByNavigation: true,
    partition: 'persist:chatgpt',
    authCookies: [
      '__Secure-next-auth.session-token',
      '__Secure-next-auth.callback-url',
      '_account',
    ],
    primaryAuthCookie: '__Secure-next-auth.session-token',
    cookieDomains: ['chatgpt.com', 'openai.com'],
    newChatLabel: /\bnew chat\b/i,
    loginHint: `log in to ${SITE_NAME} in tab A - ${PRODUCT.product} drives the web UI, so a free account works and no API key is needed`,
  },
};
