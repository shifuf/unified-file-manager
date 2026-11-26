const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const publicRoot = path.resolve(__dirname, '../../apps/web/public');
const manifest = JSON.parse(fs.readFileSync(path.join(publicRoot, 'manifest.webmanifest'), 'utf8'));

for (const size of [192, 512]) {
  test(`the ${size}px PWA icon renders the current SVG design at its declared size`, async () => {
    const entry = manifest.icons.find(icon => icon.sizes === `${size}x${size}`);
    assert.equal(entry.type, 'image/png');
    const filename = path.join(publicRoot, entry.src.replace(/^\//, ''));
    const metadata = await sharp(filename).metadata();
    assert.equal(metadata.width, size); assert.equal(metadata.height, size);
    // The maskable asset has a full blue background and a 1/16 inset, keeping
    // the folder inside the central 80% safe circle used by launcher masks.
    const inset = size === 512 ? 32 : 0;
    let rendering = sharp(path.join(publicRoot, 'favicon.svg')).resize(size - inset * 2);
    if (inset) rendering = rendering.extend({ top: inset, bottom: inset, left: inset, right: inset, background: '#2563eb' }).flatten({ background: '#2563eb' });
    const expected = await rendering.ensureAlpha().raw().toBuffer();
    const actual = await sharp(filename).ensureAlpha().raw().toBuffer();
    assert.ok(actual.equals(expected), 'installed PWA artwork must match the current SVG rather than a stale or blank icon');
    if (entry.purpose.includes('maskable')) {
      let foreground = 0;
      for (let index = 0; index < actual.length; index += 4) {
        if (actual[index] < 240 || actual[index + 1] < 240 || actual[index + 2] < 240) continue;
        foreground++;
        const pixel = index / 4, x = pixel % size + .5 - size / 2, y = Math.floor(pixel / size) + .5 - size / 2;
        assert.ok(Math.hypot(x, y) <= size * .4, 'essential folder artwork fits the launcher mask safe circle');
      }
      assert.ok(foreground > size * size * .1);
    }
  });
}
