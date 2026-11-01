/**
 * Subresource Integrity for every script a build emits. The remote manifest pins remoteEntry.js with an
 * integrity hash (the SDK requires one outside local, dev and test); this plugin pins the shell's entry
 * in its index.html (every <script src> the build's HTML references) and every chunk the entries load
 * later (a remote's exposed modules, shared-module fallbacks, the shell's split chunks).
 *
 * Each runtime chunk (the shell's main bundle, a remote's remoteEntry.js) carries a map of chunk id →
 * sha384 integrity of every lazily loadable JS chunk of its build, and webpack's script loader sets
 * script.integrity from it. A tampered or swapped chunk is refused by the browser, and the load fails as a
 * chunk-load error. The chain of trust: manifest (remote) or index.html (shell) → entry → chunks.
 *
 * Built on webpack's own hooks rather than webpack-subresource-integrity, whose Module Federation support
 * is broken and unmaintained (waysact/webpack-subresource-integrity#176, #220, #230).
 */
import { createHash } from 'node:crypto';
import type { Chunk, Compilation, Compiler } from 'webpack';

const NAME = 'PlatformChunkIntegrityPlugin';
/** Replaced, after minification, by the map; a string literal so every minifier keeps it. */
export const INTEGRITY_PLACEHOLDER = '__PLATFORM_CHUNK_INTEGRITY__';
/**
 * The integrity a chunk the build did not hash gets at run time: well-formed, so the browser enforces
 * it (a malformed value would be ignored), and matching no content, so the load fails closed.
 */
export const MISSING_INTEGRITY = `sha384-${Buffer.alloc(48).toString('base64')}`;

/** The SRI value of `content` (sha384, as the remote manifest's integrity field). */
export function integrityOf(content: Buffer | string): string {
  return `sha384-${createHash('sha384').update(content).digest('base64')}`;
}

/** The script loader's addition: the chunk's integrity, or one that fails closed for an unknown chunk. */
const createScriptCode = (require: string) =>
  [
    `if (chunkId !== undefined && ${require}.sriHashes) {`,
    `  script.integrity = ${require}.sriHashes[chunkId] || ${JSON.stringify(MISSING_INTEGRITY)};`,
    '}',
  ].join('\n');

/** The lazily loadable JS file of a chunk; undefined for chunks loaded as entries or without JS. */
function lazyScript(chunk: Chunk): string | undefined {
  if (chunk.hasRuntime()) return undefined; // an entry: pinned in the build's HTML, or by the remote manifest
  const js = [...chunk.files].filter((f) => f.endsWith('.js'));
  if (js.length > 1) throw new Error(`chunk ${String(chunk.id)} has ${js.length} JS files (${js.join(', ')}); integrity expects one`);
  return js[0];
}

const SCRIPT_TAG = /<script\b[^>]*>/gi;
const SRC = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** The emitted asset a script src names (publicPath stripped), or undefined for another URL. */
function assetOf(compilation: Compilation, src: string): string | undefined {
  const path = src.replace(/[?#].*$/, '');
  const pp = compilation.outputOptions.publicPath;
  const prefix = typeof pp === 'string' && pp !== 'auto' ? pp : '';
  const name = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path.replace(/^\.?\//, '');
  return name.endsWith('.js') && compilation.getAsset(name) ? name : undefined;
}

/**
 * Every <script src> in `html` that names an emitted script, with that script's integrity: the
 * attribute added (with crossorigin, which a cross-origin integrity-checked script needs), or, once
 * added, checked. Returns the HTML and the scripts whose attribute does not match.
 */
function pinScripts(compilation: Compilation, html: string, add: boolean): { html: string; wrong: string[] } {
  const wrong: string[] = [];
  const out = html.replace(SCRIPT_TAG, (tag) => {
    const m = SRC.exec(tag);
    const asset = m && assetOf(compilation, m[1] ?? m[2] ?? m[3] ?? '');
    if (!asset) return tag;
    const want = integrityOf(compilation.getAsset(asset)!.source.buffer());
    const have = /\bintegrity\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    if (!add) {
      if (have !== want) wrong.push(asset);
      return tag;
    }
    if (have !== undefined) return tag.replace(/\bintegrity\s*=\s*"[^"]*"/i, `integrity="${want}"`);
    const cross = /\bcrossorigin\b/i.test(tag) ? '' : ' crossorigin="anonymous"';
    return tag.replace(/\s*\/?>$/, (end) => ` integrity="${want}"${cross}${end}`);
  });
  return { html: out, wrong };
}

/** chunk id → integrity of every lazily loadable JS chunk, in chunk order (a stable key order). */
function lazyIntegrities(compilation: Compilation): Map<string | number, string> {
  const out = new Map<string | number, string>();
  for (const chunk of compilation.chunks) {
    const file = lazyScript(chunk);
    if (file === undefined || chunk.id === null) continue;
    out.set(chunk.id, integrityOf(compilation.getAsset(file)!.source.buffer()));
  }
  return out;
}

/**
 * Adds the integrity map to every runtime chunk and an integrity attribute to every script webpack
 * loads. The map goes in after minification and before source maps (so the maps account for its text).
 * After the final content hashing, which can still rewrite a chunk (Terser's license banner names the
 * chunk's own file, whose hash it renames), the hashes are taken again and the map replaced by one of
 * the same length (same keys, 64-character values), so no source-map column moves. A last check before
 * the build is reported fails the build if any chunk no longer matches the map the browser will enforce.
 */
export class ChunkIntegrityPlugin {
  apply(compiler: Compiler): void {
    const { webpack } = compiler;
    const { RuntimeGlobals, RuntimeModule, Compilation: C, WebpackError } = webpack;
    const { ReplaceSource } = webpack.sources;

    class IntegrityMapRuntimeModule extends RuntimeModule {
      constructor() {
        super('chunk integrity', RuntimeModule.STAGE_NORMAL);
      }
      override generate(): string {
        return `${RuntimeGlobals.require}.sriHashes = "${INTEGRITY_PLACEHOLDER}";`;
      }
    }

    compiler.hooks.thisCompilation.tap(NAME, (compilation: Compilation) => {
      const fail = (message: string) => compilation.errors.push(new WebpackError(`${NAME}: ${message}`));
      /** The map text currently in the runtime chunks. */
      let shipped: string | undefined;

      /** Replaces every occurrence of `from` (offset by `pad` on each side) in the runtime chunks with `to`. */
      const replaceInRuntimeChunks = (from: string, pad: number, to: string): void => {
        for (const chunk of compilation.chunks) {
          if (!chunk.hasRuntime()) continue;
          for (const file of chunk.files) {
            if (!file.endsWith('.js')) continue;
            const asset = compilation.getAsset(file)!;
            const text = asset.source.source().toString();
            const replaced = new ReplaceSource(asset.source);
            let found = 0;
            for (let i = text.indexOf(from); i >= 0; i = text.indexOf(from, i + from.length)) {
              replaced.replace(i - pad, i + from.length - 1 + pad, to);
              found++;
            }
            if (found === 0) fail(`runtime chunk ${file} has no integrity map`);
            else compilation.updateAsset(file, replaced);
          }
        }
      };

      compilation.hooks.additionalTreeRuntimeRequirements.tap(NAME, (chunk) => {
        compilation.addRuntimeModule(chunk, new IntegrityMapRuntimeModule());
      });
      webpack.runtime.LoadScriptRuntimeModule.getCompilationHooks(compilation).createScript.tap(
        NAME,
        (source) => `${source}\n${createScriptCode(RuntimeGlobals.require)}`,
      );

      // After minification, before source maps: the placeholder literal (with the quotes a minifier may
      // have changed) becomes the map.
      compilation.hooks.processAssets.tap({ name: NAME, stage: C.PROCESS_ASSETS_STAGE_DEV_TOOLING - 1 }, () => {
        try {
          shipped = JSON.stringify(Object.fromEntries(lazyIntegrities(compilation)));
        } catch (e) {
          fail((e as Error).message);
          return;
        }
        replaceInRuntimeChunks(INTEGRITY_PLACEHOLDER, 1, shipped);
      });

      // After the final content hashing: the same keys, the final hashes, the same length.
      compilation.hooks.processAssets.tap({ name: NAME, stage: C.PROCESS_ASSETS_STAGE_OPTIMIZE_HASH + 1 }, () => {
        if (shipped === undefined) return;
        const final = JSON.stringify(Object.fromEntries(lazyIntegrities(compilation)));
        if (final === shipped) return;
        if (final.length !== shipped.length) {
          fail('the set of lazily loaded chunks changed after minification');
          return;
        }
        replaceInRuntimeChunks(shipped, 0, final);
        shipped = final;
      });

      // The entries the build's HTML loads (the shell's index.html), once the scripts are final.
      compilation.hooks.processAssets.tap({ name: NAME, stage: C.PROCESS_ASSETS_STAGE_OPTIMIZE_HASH + 2 }, () => {
        for (const a of compilation.getAssets()) {
          if (!a.name.endsWith('.html')) continue;
          const { html } = pinScripts(compilation, a.source.source().toString(), true);
          compilation.updateAsset(a.name, new webpack.sources.RawSource(html));
        }
      });

      // Last: every chunk still matches the map the browser will enforce, and every pinned entry its tag.
      compilation.hooks.processAssets.tap({ name: NAME, stage: C.PROCESS_ASSETS_STAGE_REPORT - 1 }, () => {
        if (shipped !== undefined) {
          const map = JSON.parse(shipped) as Record<string, string>;
          for (const [id, have] of lazyIntegrities(compilation)) {
            if (map[String(id)] !== have) fail(`chunk ${String(id)} changed after its integrity was recorded; the browser would refuse it`);
          }
        }
        for (const a of compilation.getAssets()) {
          if (!a.name.endsWith('.html')) continue;
          for (const s of pinScripts(compilation, a.source.source().toString(), false).wrong) {
            fail(`${a.name} loads ${s} without its current integrity; the browser would refuse it`);
          }
        }
      });
    });
  }
}
