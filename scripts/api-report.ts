// Runs api-extractor once per implemented subpath (design doc §C5 drift item 5): the public API of
// each subpath is snapshotted in packages/frontend-sdk/api/<name>.api.md. Locally the report is
// updated; with --check (CI) a changed report fails, so every API change is reviewed with a changeset.
// Run after `pnpm build` (it reads dist/<name>/index.d.ts).
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Extractor, ExtractorConfig, ExtractorLogLevel } from '@microsoft/api-extractor';
import { SDK_DIR, implementedSubpaths } from './lib/subpaths.ts';

function main(): void {
  const check = process.argv.includes('--check') || process.env.CI === 'true';
  const subpaths = implementedSubpaths();
  if (subpaths.length === 0) {
    console.log('api-report: no subpaths implemented yet');
    return;
  }
  mkdirSync(join(SDK_DIR, 'api'), { recursive: true });
  const failed: string[] = [];
  for (const name of subpaths) {
    const entry = join(SDK_DIR, 'dist', name, 'index.d.ts');
    if (!existsSync(entry)) throw new Error(`${entry} not found: run \`pnpm build\` first`);
    const config = ExtractorConfig.prepare({
      configObjectFullPath: join(SDK_DIR, `api-extractor.${name}.json`),
      packageJsonFullPath: join(SDK_DIR, 'package.json'),
      configObject: {
        projectFolder: SDK_DIR,
        mainEntryPointFilePath: entry,
        compiler: { tsconfigFilePath: join(SDK_DIR, 'tsconfig.json') },
        apiReport: {
          enabled: true,
          reportFileName: `${name}.api.md`,
          reportFolder: join(SDK_DIR, 'api'),
          reportTempFolder: join(SDK_DIR, 'temp'),
        },
        docModel: { enabled: false },
        dtsRollup: { enabled: false },
        tsdocMetadata: { enabled: false },
        messages: {
          extractorMessageReporting: { 'ae-missing-release-tag': { logLevel: ExtractorLogLevel.None } },
        },
      },
    });
    const result = Extractor.invoke(config, { localBuild: !check, showVerboseMessages: false });
    if (!result.succeeded) failed.push(name);
  }
  if (failed.length > 0) {
    console.error(`api-report: public API changed or invalid for ${failed.map((n) => `/${n}`).join(', ')}`);
    process.exit(1);
  }
}

main();
