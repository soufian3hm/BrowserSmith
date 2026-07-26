#!/usr/bin/env node
'use strict';
/**
 * Generate the NSIS installer artwork from assets/logo.png.
 *
 *   npm run installer-art
 *
 * NSIS only accepts BMP for the welcome sidebar and the header strip, and
 * sharp cannot write BMP - so the pixels are composed with sharp and then
 * encoded here as a 24-bit bottom-up BMP, which is the one format every NSIS
 * build accepts without a plugin.
 *
 * Sizes are fixed by NSIS itself: 164x314 for the welcome/finish sidebar and
 * 150x57 for the header shown on every other page.
 */
const path = require('node:path');
const fs = require('node:fs');
const sharp = require('sharp');

const ASSETS = path.join(__dirname, '..', 'assets');
const LOGO = path.join(ASSETS, 'logo-square.png');

/** Encode raw RGB into a 24-bit BMP (bottom-up, 4-byte aligned rows). */
function toBmp(rgb, width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixels = Buffer.alloc(rowSize * height, 0);

  for (let y = 0; y < height; y++) {
    // BMP scanlines run bottom-to-top.
    const src = (height - 1 - y) * width * 3;
    let dst = y * rowSize;
    for (let x = 0; x < width; x++) {
      const i = src + x * 3;
      pixels[dst++] = rgb[i + 2]; // B
      pixels[dst++] = rgb[i + 1]; // G
      pixels[dst++] = rgb[i]; //     R
    }
  }

  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10); // pixel data offset
  header.writeUInt32LE(40, 14); // DIB header size
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26); // planes
  header.writeUInt16LE(24, 28); // bits per pixel
  header.writeUInt32LE(pixels.length, 34);
  header.writeInt32LE(2835, 38); // 72 DPI
  header.writeInt32LE(2835, 42);
  return Buffer.concat([header, pixels]);
}

async function write(name, width, height, svg, logoSize, logoTop) {
  const logo = await sharp(LOGO).resize(logoSize, logoSize).toBuffer();
  const { data } = await sharp(Buffer.from(svg))
    .composite([{ input: logo, left: Math.round((width - logoSize) / 2), top: logoTop }])
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const file = path.join(ASSETS, name);
  fs.writeFileSync(file, toBmp(data, width, height));
  console.log(`${name}  ${width}x${height}  ${Math.round(fs.statSync(file).size / 1024)}KB`);
}

async function main() {
  if (!fs.existsSync(LOGO)) throw new Error(`missing ${LOGO} - run \`npm run icons\` first`);

  // Welcome / finish page: the logo over the product's own gradient, with the
  // name set low enough to clear NSIS's own text block on the right.
  await write(
    'installerSidebar.bmp',
    164,
    314,
    `<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314">
       <defs>
         <linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1">
           <stop offset="0" stop-color="#0FA98C"/>
           <stop offset="0.5" stop-color="#0B7F82"/>
           <stop offset="1" stop-color="#08243B"/>
         </linearGradient>
       </defs>
       <rect width="164" height="314" fill="url(#g)"/>
       <text x="82" y="232" text-anchor="middle" font-family="Segoe UI, sans-serif"
             font-size="19" font-weight="700" fill="#FFFFFF">BrowserSmith</text>
       <text x="82" y="256" text-anchor="middle" font-family="Segoe UI, sans-serif"
             font-size="10.5" fill="#BFE9E2">One sentence in.</text>
       <text x="82" y="271" text-anchor="middle" font-family="Segoe UI, sans-serif"
             font-size="10.5" fill="#BFE9E2">A running app out.</text>
       <text x="82" y="295" text-anchor="middle" font-family="Segoe UI, sans-serif"
             font-size="9.5" fill="#7FC9C4">No API key required</text>
     </svg>`,
    104,
    64
  );

  // Header strip: dark, logo left, wordmark beside it.
  await write(
    'installerHeader.bmp',
    150,
    57,
    `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="57">
       <rect width="150" height="57" fill="#0B1220"/>
       <text x="60" y="27" font-family="Segoe UI, sans-serif" font-size="13"
             font-weight="700" fill="#FFFFFF">Browser</text>
       <text x="60" y="43" font-family="Segoe UI, sans-serif" font-size="13"
             font-weight="700" fill="#2DD4BF">Smith</text>
     </svg>`,
    44,
    7
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
