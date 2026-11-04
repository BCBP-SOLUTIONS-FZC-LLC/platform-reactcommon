/**
 * Subresource Integrity for every script and stylesheet a build emits. The remote manifest pins
 * remoteEntry.js with an integrity hash (the SDK requires one outside local, dev and test); this plugin
 * pins the shell's entry in its index.html (every <script src> and <link rel="stylesheet" href> the
 * build's HTML references) and every chunk the entries load later (a remote's exposed modules,
 * shared-module fallbacks, the shell's split chunks), JS and CSS.
 *
 * Each runtime chunk (the shell's main bundle, a remote's remoteEntry.js) carries two maps of chunk id →
 * sha384 integrity: one of every lazily loadable JS chunk of its build, which webpack's script loader
 * reads to set script.integrity, and one of every lazily loadable CSS file, which the CSS loader reads to
 * set link.integrity. A tampered or swapped chunk is refused by the browser, and the load fails as a
 * chunk-load error. The chain of trust: manifest (remote) or index.html (shell) → entry → chunks.
 *
 * The CSS loaders: mini-css-extract-plugin (its beforeTagInsert hook) and webpack's native CSS
 * (experiments.css: CssLoadingRuntimeModule's createStylesheet hook) on webpack; CssExtractRspackPlugin
 * and native CSS on Rspack and Rsbuild (RuntimePlugin's createLink hook). A build with lazily loaded CSS
 * whose runtime carries no integrity lookup for it fails, rather than ship CSS the browser does not check.
 *
 * Built on webpack's own hooks rather than webpack-subresource-integrity, whose Module Federation support
 * is broken and unmaintained (waysact/webpack-subresource-integrity#176, #220, #230). The same plugin runs
 * on Rspack, whose JS API offers the same hooks (the script and link hooks on its RuntimePlugin), so both
 * bundlers fail closed the same way.
 */
import type { Chunk, Compilation, Compiler } from 'webpack';
import { INTEGRITY_PLACEHOLDER, MISSING_INTEGRITY, integrityOf } from './shared.ts';

export { INTEGRITY_PLACEHOLDER, MISSING_INTEGRITY, integrityOf };

const NAME = 'PlatformChunkIntegrityPlugin';
/** Replaced, like INTEGRITY_PLACEHOLDER, by the map of the lazily loaded CSS files. */
const CSS_INTEGRITY_PLACEHOLDER = '__PLATFORM_CSS_INTEGRITY__';

type Ext = '.js' | '.css';
/** Per kind of lazily loaded file: the runtime property its map lives on (minifiers keep property names), its placeholder. */
const KINDS: readonly { ext: Ext; map: string; placeholder: string }[] = [
  { ext: '.js', map: 'sriHashes', placeholder: INTEGRITY_PLACEHOLDER },
  { ext: '.css', map: 'sriCssHashes', placeholder: CSS_INTEGRITY_PLACEHOLDER },
];

/**
 * A loader's addition: the chunk's integrity on the element it creates, or one that fails closed for an
 * unknown chunk.
 */
const integrityCode = (require: string, map: string, element: string, chunkId = 'chunkId') =>
  [
    `if (${chunkId} !== undefined && ${require}.${map}) {`,
    `  ${element}.integrity = ${require}.${map}[${chunkId}] || ${JSON.stringify(MISSING_INTEGRITY)};`,
    '}',
  ].join('\n');

type ScriptHook = { tap(name: string, fn: (source: string) => string): void };
type LinkHook = { tap(name: string, fn: (source: string) => string): void };
/** mini-css-extract-plugin's beforeTagInsert: called with the names of the link element and chunk id variables. */
type TagInsertHook = { tap(name: string, fn: (source: string, names: { tag: string; chunkId: string }) => string): void };

/**
 * The hook through which a plugin adds to the <script> the chunk loader creates: webpack's
 * LoadScriptRuntimeModule, Rspack's RuntimePlugin (the same `createScript` waterfall).
 */
function createScriptHook(webpack: Compiler['webpack'], compilation: Compilation): ScriptHook {
  if (webpack.runtime?.LoadScriptRuntimeModule) return webpack.runtime.LoadScriptRuntimeModule.getCompilationHooks(compilation).createScript;
  const rspack = (webpack as unknown as { RuntimePlugin?: { getCompilationHooks?(c: Compilation): { createScript: ScriptHook } } }).RuntimePlugin;
  if (rspack?.getCompilationHooks) return rspack.getCompilationHooks(compilation).createScript;
  throw new Error(`${NAME}: this bundler has no createScript hook (webpack 5 or Rspack is required)`);
}

/** The variable a CSS loader's code assigns its new <link> element to. */
const LINK_ELEMENT = /([A-Za-z_$][\w$]*)\s*=\s*document\.createElement\((["'])link\2\)/;

/**
 * Taps every CSS loader hook this bundler offers with the CSS integrity code: Rspack's createLink
 * (CssExtractRspackPlugin, native CSS; Rsbuild), webpack's native CSS createStylesheet, and the
 * beforeTagInsert of every mini-css-extract-plugin the build registered (its hooks hang off its own
 * class). A loader whose code names no <link> element fails the build.
 */
function tapCssLoaders(compiler: Compiler, compilation: Compilation, require: string, fail: (message: string) => void): void {
  const { webpack } = compiler;
  const map = KINDS[1]!.map;
  const append = (source: string): string => {
    const element = LINK_ELEMENT.exec(source)?.[1];
    if (element) return `${source}\n${integrityCode(require, map, element)}`;
    fail('a CSS loader creates its <link> in a way this plugin does not recognise; its chunks would load without integrity');
    return source;
  };
  const rspack = (webpack as unknown as { RuntimePlugin?: { getCompilationHooks?(c: Compilation): { createLink?: LinkHook } } }).RuntimePlugin;
  rspack?.getCompilationHooks?.(compilation).createLink?.tap(NAME, append);
  const native = (webpack as unknown as { css?: { CssLoadingRuntimeModule?: { getCompilationHooks?(c: Compilation): { createStylesheet?: LinkHook } } } }).css?.CssLoadingRuntimeModule;
  native?.getCompilationHooks?.(compilation).createStylesheet?.tap(NAME, append);
  // mini-css-extract-plugin keeps one hook registry per copy of its module: use the class the build registered.
  const seen = new Set<unknown>();
  for (const plugin of compiler.options.plugins ?? []) {
    const ctor = (plugin as { constructor?: { name?: string; getCompilationHooks?(c: Compilation): { beforeTagInsert?: TagInsertHook } | undefined } } | null | undefined)
      ?.constructor;
    if (ctor?.name !== 'MiniCssExtractPlugin' || seen.has(ctor) || typeof ctor.getCompilationHooks !== 'function') continue;
    seen.add(ctor);
    const hooks = ctor.getCompilationHooks(compilation);
    hooks?.beforeTagInsert?.tap?.(NAME, (source, names) => `${source}\n${integrityCode(require, map, names.tag, names.chunkId)}`);
  }
}

/**
 * Chunks a runtime can load on demand: every runtime chunk's async chunks (webpack and Rspack both give
 * them), else those that cannot be initial. A chunk the HTML loads at startup is not one: a CSS file in a
 * runtimeChunk: 'single' build or a `css/mini-extract` cacheGroup is pinned by the HTML instead.
 */
function onDemandChunks(compilation: Compilation): Set<Chunk> {
  const out = new Set<Chunk>();
  let known = false;
  for (const chunk of compilation.chunks) {
    const all = (chunk as { getAllAsyncChunks?(): Iterable<Chunk> }).getAllAsyncChunks;
    if (!chunk.hasRuntime() || typeof all !== 'function') continue;
    known = true;
    for (const c of all.call(chunk)) out.add(c);
  }
  if (!known) for (const chunk of compilation.chunks) if (!chunk.canBeInitial()) out.add(chunk);
  return out;
}

/** The lazily loadable file with `ext` of a chunk; undefined for chunks loaded as entries or without one. */
function lazyFile(chunk: Chunk, ext: Ext, onDemand?: Set<Chunk>): string | undefined {
  if (chunk.hasRuntime()) return undefined; // an entry: pinned in the build's HTML, or by the remote manifest
  if (onDemand && !onDemand.has(chunk)) return undefined; // loaded at startup: pinned in the build's HTML
  const files = [...chunk.files].filter((f) => f.endsWith(ext));
  if (files.length > 1) throw new Error(`chunk ${String(chunk.id)} has ${files.length} ${ext === '.js' ? 'JS' : 'CSS'} files (${files.join(', ')}); integrity expects one`);
  return files[0];
}

/** <script> and <link>: the tags whose resource (a script's src, a stylesheet's href) the HTML pins. */
const TAG = /<(script|link)\b[^>]*>/gi;
const SRC = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const STYLESHEET = /\brel\s*=\s*(?:"\s*stylesheet\s*"|'\s*stylesheet\s*'|stylesheet(?=[\s/>]))/i;

/** The emitted asset with `ext` a URL names (publicPath stripped), or undefined for another URL. */
function assetOf(compilation: Compilation, src: string, ext: Ext): string | undefined {
  const path = src.replace(/[?#].*$/, '');
  const pp = compilation.outputOptions.publicPath;
  const prefix = typeof pp === 'string' && pp !== 'auto' ? pp : '';
  const name = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path.replace(/^\.?\//, '');
  return name.endsWith(ext) && compilation.getAsset(name) ? name : undefined;
}

/** The emitted script a <script src>, or stylesheet a <link rel="stylesheet" href>, loads; else undefined. */
function tagAsset(compilation: Compilation, tag: string, element: string): string | undefined {
  const script = element.toLowerCase() === 'script';
  if (!script && !STYLESHEET.test(tag)) return undefined;
  const m = (script ? SRC : HREF).exec(tag);
  return m ? assetOf(compilation, m[1] ?? m[2] ?? m[3] ?? '', script ? '.js' : '.css') : undefined;
}

/**
 * Every <script src> and <link rel="stylesheet" href> in `html` that names an emitted script or
 * stylesheet, with that file's integrity: the attribute added (with crossorigin, which a cross-origin
 * integrity-checked resource needs), or, once added, checked. Returns the HTML and the files whose
 * attribute does not match.
 */
function pinTags(compilation: Compilation, html: string, add: boolean): { html: string; wrong: string[] } {
  const wrong: string[] = [];
  const out = html.replace(TAG, (tag, element: string) => {
    const asset = tagAsset(compilation, tag, element);
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

/** chunk id → integrity of every lazily loadable file with `ext`, in chunk order (a stable key order). */
function lazyIntegrities(compilation: Compilation, ext: Ext): Map<string | number, string> {
  const out = new Map<string | number, string>();
  // CSS only: an initial CSS chunk has no loader that reads the map (mini-css-extract adds one only for
  // async CSS), so mapping it would fail the loader check below. JS keeps every non-runtime chunk.
  const onDemand = ext === '.css' ? onDemandChunks(compilation) : undefined;
  for (const chunk of compilation.chunks) {
    const file = lazyFile(chunk, ext, onDemand);
    if (file === undefined || chunk.id === null) continue;
    out.set(chunk.id, integrityOf(compilation.getAsset(file)!.source.buffer()));
  }
  return out;
}

/** The text of every runtime chunk's JS files. */
function runtimeTexts(compilation: Compilation): string[] {
  const out: string[] = [];
  for (const chunk of compilation.chunks) {
    if (!chunk.hasRuntime()) continue;
    for (const file of chunk.files) if (file.endsWith('.js')) out.push(compilation.getAsset(file)!.source.source().toString());
  }
  return out;
}

/**
 * Adds the integrity maps to every runtime chunk and an integrity attribute to every script and
 * stylesheet webpack loads. The maps go in after minification and before source maps (so the maps
 * account for their text). After the final content hashing, which can still rewrite a chunk (Terser's
 * license banner names the chunk's own file, whose hash it renames), the hashes are taken again and each
 * map replaced by one of the same length (same keys, 64-character values), so no source-map column
 * moves. A last check before the build is reported fails the build if any chunk no longer matches the
 * map the browser will enforce, or if lazily loaded CSS has no loader that reads its map.
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
        return KINDS.map((k) => `${RuntimeGlobals.require}.${k.map} = "${k.placeholder}";`).join('\n');
      }
    }

    compiler.hooks.thisCompilation.tap(NAME, (compilation: Compilation) => {
      const fail = (message: string) => compilation.errors.push(new WebpackError(`${NAME}: ${message}`));
      /** Per kind, the map text currently in the runtime chunks. */
      const shipped = new Map<Ext, string>();

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
      const mapOf = (ext: Ext) => JSON.stringify(Object.fromEntries(lazyIntegrities(compilation, ext)));

      compilation.hooks.additionalTreeRuntimeRequirements.tap(NAME, (chunk) => {
        compilation.addRuntimeModule(chunk, new IntegrityMapRuntimeModule());
      });
      createScriptHook(webpack, compilation).tap(NAME, (source) => `${source}\n${integrityCode(RuntimeGlobals.require, KINDS[0]!.map, 'script')}`);
      tapCssLoaders(compiler, compilation, RuntimeGlobals.require, fail);

      // After minification, before source maps: each placeholder literal (with the quotes a minifier may
      // have changed) becomes its map.
      compilation.hooks.processAssets.tap({ name: NAME, stage: C.PROCESS_ASSETS_STAGE_DEV_TOOLING - 1 }, () => {
        const maps = new Map<Ext, string>();
        try {
          for (const k of KINDS) maps.set(k.ext, mapOf(k.ext));
        } catch (e) {
          fail((e as Error).message);
          return;
        }
        for (const k of KINDS) {
          const map = maps.get(k.ext)!;
          replaceInRuntimeChunks(k.placeholder, 1, map);
          shipped.set(k.ext, map);
        }
      });

      // After the final content hashing: the same keys, the final hashes, the same length.
      compilation.hooks.processAssets.tap({ name: NAME, stage: C.PROCESS_ASSETS_STAGE_OPTIMIZE_HASH + 1 }, () => {
        for (const k of KINDS) {
          const before = shipped.get(k.ext);
          if (before === undefined) continue;
          const final = mapOf(k.ext);
          if (final === before) continue;
          if (final.length !== before.length) {
            fail('the set of lazily loaded chunks changed after minification');
            continue;
          }
          replaceInRuntimeChunks(before, 0, final);
          shipped.set(k.ext, final);
        }
      });

      // The entries the build's HTML loads (the shell's index.html), once the scripts are final.
      compilation.hooks.processAssets.tap({ name: NAME, stage: C.PROCESS_ASSETS_STAGE_OPTIMIZE_HASH + 2 }, () => {
        for (const a of compilation.getAssets()) {
          if (!a.name.endsWith('.html')) continue;
          const { html } = pinTags(compilation, a.source.source().toString(), true);
          compilation.updateAsset(a.name, new webpack.sources.RawSource(html));
        }
      });

      // Last: every chunk still matches the map the browser will enforce, every pinned entry its tag, and
      // lazily loaded CSS has a loader that reads its map.
      compilation.hooks.processAssets.tap({ name: NAME, stage: C.PROCESS_ASSETS_STAGE_REPORT - 1 }, () => {
        for (const k of KINDS) {
          const text = shipped.get(k.ext);
          if (text === undefined) continue;
          const map = JSON.parse(text) as Record<string, string>;
          for (const [id, have] of lazyIntegrities(compilation, k.ext)) {
            if (map[String(id)] !== have) fail(`chunk ${String(id)} changed after its integrity was recorded; the browser would refuse it`);
          }
          const css = Object.keys(map);
          const reader = new RegExp(`\\.${KINDS[1]!.map}\\[`);
          if (k.ext === '.css' && css.length > 0 && !runtimeTexts(compilation).some((t) => reader.test(t))) {
            fail(
              `the build loads CSS chunks lazily (chunks ${css.join(', ')}) with a loader that sets no integrity; ` +
                'use mini-css-extract-plugin or native CSS (webpack), CssExtractRspackPlugin or native CSS (Rspack, Rsbuild)',
            );
          }
        }
        for (const a of compilation.getAssets()) {
          if (!a.name.endsWith('.html')) continue;
          for (const s of pinTags(compilation, a.source.source().toString(), false).wrong) {
            fail(`${a.name} loads ${s} without its current integrity; the browser would refuse it`);
          }
        }
      });
    });
  }
}
