#!/usr/bin/env node
'use strict';
/**
 * Regenerate every icon from assets/logo.png.
 *
 *   npm run icons
 *
 * logo.png is the single source of truth - the only file a designer edits.
 * Everything else here is derived and safe to delete, which is why the .ico and
 * the PNG set are rebuilt rather than hand-maintained.
 */
const path = require('node:path');
const fs = require('node:fs');

/**
 * Maintainer-only tooling: sharp and png-to-ico are NOT declared dependencies.
 * The generated icons are committed, so a stranger cloning this repo never needs
 * them - declaring them would add tens of MB of platform natives to every first
 * install for a step nobody but the maintainer runs.
 */
function requireOrExplain(name) {
  try {
    return require(name);
  } catch {
    console.error(
      [
        `${name} is not installed.`,
        'This script is maintainer tooling and its dependencies are deliberately',
        'not in package.json - the generated assets are committed, so nobody',
        'cloning the repo needs them. Install them on demand:',
        '',
        '  npm i --no-save sharp png-to-ico',
        '',
      ].join('\n')
    );
    process.exit(1);
  }
}

const sharp = requireOrExplain('sharp');
const toIcoModule = requireOrExplain('png-to-ico');
const toIco = toIcoModule.default || toIcoModule;

const ASSETS = path.join(__dirname, '..', 'assets');
const SRC = path.join(ASSETS, 'logo.png');
const PNG_DIR = path.join(ASSETS, 'png');

// Windows asks for all of these; the larger sizes cover the Start menu, the
// installer header and macOS/Linux.
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  if (!fs.existsSync(SRC)) throw new Error(`missing ${SRC}`);

  // Trim the transparent margin, then pad back to a true square. Without this
  // a non-square source is letterboxed by `fit: contain` and every icon size
  // ends up with the plate slightly off-centre.
  const trimmed = await sharp(SRC).trim().toBuffer();
  const { width, height } = await sharp(trimmed).metadata();
  const side = Math.max(width, height);
  const square = await sharp(trimmed)
    .extend({
      top: Math.floor((side - height) / 2),
      bottom: Math.ceil((side - height) / 2),
      left: Math.floor((side - width) / 2),
      right: Math.ceil((side - width) / 2),
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  fs.mkdirSync(PNG_DIR, { recursive: true });
  fs.writeFileSync(path.join(ASSETS, 'logo-square.png'), square);

  for (const size of SIZES) {
    await sharp(square)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(path.join(PNG_DIR, `logo-${size}.png`));
  }

  // The name electron-builder and the About dialog reference directly.
  await sharp(square).resize(512, 512).png().toFile(path.join(ASSETS, 'logo-512.png'));

  fs.writeFileSync(
    path.join(ASSETS, 'logo.ico'),
    await toIco(ICO_SIZES.map((s) => path.join(PNG_DIR, `logo-${s}.png`)))
  );

  console.log(`logo.png ${width}x${height} -> square ${side}x${side}`);
  console.log(`logo.ico (${ICO_SIZES.join(', ')})  +  ${SIZES.length} PNGs`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
