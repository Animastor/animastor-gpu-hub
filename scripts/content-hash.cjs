#!/usr/bin/env node
'use strict';

/**
 * Deterministic CONTENT digest of the app filesystem inside the image:
 *   sha256 over sorted lines "f:<sha256(file)>  <relpath>" /
 *                              "l:<sha256(link-target)>  <relpath>"
 * computed under ROOT (default /app). Prints "<file-count> <digest>".
 *
 * Purpose: image DIGESTS are not reproducible across builds (layer tar
 * mtimes and image config timestamps come from build time), so build
 * reproducibility is proven on content identity instead: two independent
 * clean builds must print the same line. CI records it next to the pushed
 * digest so local and CI images can be compared byte-for-byte.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(process.argv[2] || '/app');

const lines = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (e.isDirectory()) {
      walk(full);
    } else if (e.isSymbolicLink()) {
      const target = fs.readlinkSync(full);
      lines.push(`l:${crypto.createHash('sha256').update(target).digest('hex')}  ${rel}`);
    } else if (e.isFile()) {
      const h = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      lines.push(`f:${h}  ${rel}`);
    }
  }
})(ROOT);

lines.sort();
const digest = crypto.createHash('sha256').update(lines.join('\n') + (lines.length ? '\n' : '')).digest('hex');
console.log(`${lines.length} ${digest}`);
