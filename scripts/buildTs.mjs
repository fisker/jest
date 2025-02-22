/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'assert';
import os from 'os';
import path from 'path';
import chalk from 'chalk';
import execa from 'execa';
import globby from 'globby';
import fs from 'graceful-fs';
import stripJsonComments from 'strip-json-comments';
import throat from 'throat';
import {getPackages} from './buildUtils.mjs';

(async () => {
  const packages = getPackages();

  const packagesWithTs = packages.filter(p =>
    fs.existsSync(path.resolve(p.packageDir, 'tsconfig.json')),
  );

  const {stdout: allWorkspacesString} = await execa('yarn', [
    'workspaces',
    'list',
    '--json',
  ]);

  const workspacesWithTs = new Map(
    JSON.parse(`[${allWorkspacesString.split('\n').join(',')}]`)
      .filter(({location}) =>
        packagesWithTs.some(({packageDir}) => packageDir.endsWith(location)),
      )
      .map(({location, name}) => [name, location]),
  );

  packagesWithTs.forEach(({packageDir, pkg}) => {
    assert.ok(pkg.types, `Package ${pkg.name} is missing \`types\` field`);

    assert.strictEqual(
      pkg.types,
      pkg.main.replace(/\.js$/, '.d.ts'),
      `\`main\` and \`types\` field of ${pkg.name} does not match`,
    );

    const jestDependenciesOfPackage = Object.keys(pkg.dependencies || {})
      .concat(Object.keys(pkg.devDependencies || {}))
      .filter(dep => workspacesWithTs.has(dep))
      .filter(dep => {
        // nothing should depend on these
        if (dep === 'jest-circus' || dep === 'jest-jasmine2') {
          return false;
        }

        // these are just `require.resolve`-ed
        if (pkg.name === 'jest-config') {
          if (dep === '@jest/test-sequencer' || dep === 'babel-jest') {
            return false;
          }
        }

        return true;
      })
      .map(dep =>
        path.relative(
          packageDir,
          `${packageDir}/../../${workspacesWithTs.get(dep)}`,
        ),
      )
      .sort();

    if (jestDependenciesOfPackage.length > 0) {
      const tsConfig = JSON.parse(
        stripJsonComments(
          fs.readFileSync(`${packageDir}/tsconfig.json`, 'utf8'),
        ),
      );

      const references = tsConfig.references.map(({path}) => path);

      assert.deepStrictEqual(
        references,
        jestDependenciesOfPackage,
        `Expected declared references to match dependencies in packages ${
          pkg.name
        }. Got:\n\n${references.join(
          '\n',
        )}\nExpected:\n\n${jestDependenciesOfPackage.join('\n')}`,
      );
    }
  });

  const args = [
    'tsc',
    '-b',
    ...packagesWithTs.map(({packageDir}) => packageDir),
    ...process.argv.slice(2),
  ];

  console.log(chalk.inverse(' Building TypeScript definition files '));

  try {
    await execa('yarn', args, {stdio: 'inherit'});
    console.log(
      chalk.inverse.green(' Successfully built TypeScript definition files '),
    );
  } catch (e) {
    console.error(
      chalk.inverse.red(' Unable to build TypeScript definition files '),
    );
    throw e;
  }

  console.log(chalk.inverse(' Validating TypeScript definition files '));

  // we want to limit the number of processes we spawn
  const cpus = Math.max(1, os.cpus().length - 1);

  const typesReferenceDirective = '/// <reference types';
  const typesNodeReferenceDirective = `${typesReferenceDirective}="node" />`;

  try {
    await Promise.all(
      packagesWithTs.map(
        throat(cpus, async ({packageDir, pkg}) => {
          const buildDir = path.resolve(packageDir, 'build/**/*.d.ts');

          const globbed = await globby([buildDir]);

          const files = await Promise.all(
            globbed.map(file =>
              Promise.all([file, fs.promises.readFile(file, 'utf8')]),
            ),
          );

          const filesWithTypeReferences = files
            .filter(([, content]) => content.includes(typesReferenceDirective))
            .filter(hit => hit.length > 0);

          const filesWithReferences = filesWithTypeReferences
            .map(([name, content]) => [
              name,
              content
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.includes(typesReferenceDirective))
                .filter(line => line !== typesNodeReferenceDirective)
                .join('\n'),
            ])
            .filter(([, content]) => content.length > 0)
            .filter(hit => hit.length > 0)
            .map(([file, references]) =>
              chalk.red(
                `${chalk.bold(
                  file,
                )} has the following non-node type references:\n\n${references}\n`,
              ),
            )
            .join('\n\n');

          if (filesWithReferences) {
            throw new Error(filesWithReferences);
          }

          const filesWithNodeReference = filesWithTypeReferences.map(
            ([filename]) => filename,
          );

          if (filesWithNodeReference.length > 0) {
            assert.ok(
              pkg.dependencies,
              `Package \`${pkg.name}\` is missing \`dependencies\``,
            );
            assert.strictEqual(
              pkg.dependencies['@types/node'],
              '*',
              `Package \`${pkg.name}\` is missing a dependency on \`@types/node\``,
            );
          }
        }),
      ),
    );
  } catch (e) {
    console.error(
      chalk.inverse.red(' Unable to validate TypeScript definition files '),
    );

    throw e;
  }

  console.log(
    chalk.inverse.green(' Successfully validated TypeScript definition files '),
  );
})().catch(error => {
  console.error('Got error', error.stack);
  process.exitCode = 1;
});
