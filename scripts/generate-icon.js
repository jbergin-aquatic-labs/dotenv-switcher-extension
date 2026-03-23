#!/usr/bin/env node
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const assetsDir = path.join(root, 'assets');
const svgPath = path.join(assetsDir, 'icon.svg');
const pngPath = path.join(assetsDir, 'icon.png');

if (!fs.existsSync(svgPath)) {
  console.error('assets/icon.svg not found');
  process.exit(1);
}

sharp(fs.readFileSync(svgPath))
  .resize(128, 128)
  .png()
  .toFile(pngPath)
  .then(() => console.log('Generated assets/icon.png (128x128)'))
  .catch((err) => {
    console.error('Failed to generate icon:', err);
    process.exit(1);
  });
