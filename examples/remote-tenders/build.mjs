// Production build: `node build.mjs` (or `node build.mjs development`).
import { cpSync, existsSync } from 'node:fs';
import webpack from 'webpack';
import config from './webpack.config.mjs';

const mode = process.argv[2] === 'development' ? 'development' : 'production';
webpack(config(mode), (err, stats) => {
  if (err || stats.hasErrors()) {
    console.error(err ?? stats.toString({ all: false, errors: true }));
    process.exit(1);
  }
  if (stats.hasWarnings()) console.warn(stats.toString({ all: false, warnings: true }));
  if (existsSync('public')) cpSync('public', 'dist', { recursive: true });
  console.log(stats.toString({ all: false, assets: true, colors: false }).split('\n').slice(0, 12).join('\n'));
});
