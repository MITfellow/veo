// @ts-check
import tseslint from 'typescript-eslint';

/**
 * §D.3 — the layer rule is why §60.4 is true.
 *
 * Two families of restriction live here and neither is advisory:
 *
 *   1. Dependencies point inward only (§12). Expressed as an explicit
 *      deny-list per layer rather than an allow-list, because the
 *      message a developer sees should name the layer they broke.
 *   2. Ambient nondeterminism is unreachable outside the ports (§8).
 *      Every clock, id, random byte and environment read enters through
 *      `substrate/ports.ts` and its three implementations, so a test can
 *      advance time by months and get the same bytes twice.
 */

/** Layers, outermost first. A layer may import only from those after it. */
const INWARD = ['interface', 'orchestration', 'cognition', 'capability', 'security', 'substrate'];

/** Deny-list for one layer: every layer at or outside its own position. */
function outwardOf(layer) {
  const index = INWARD.indexOf(layer);
  return INWARD.slice(0, index).map((outer) => ({
    group: [`**/${outer}/**`, `../${outer}/*`, `../../${outer}/*`, `../../../${outer}/*`],
    message: `Layer violation (§12): ${layer}/ may not import from ${outer}/. Dependencies point inward only.`,
  }));
}

const layerRules = Object.fromEntries(
  INWARD.map((layer) => [
    layer,
    {
      files: [`src/${layer}/**/*.ts`],
      rules: {
        'no-restricted-imports': ['error', { patterns: outwardOf(layer) }],
      },
    },
  ]),
);

/**
 * The ambient-access ban.
 *
 * `no-restricted-properties` catches the member forms; `no-restricted-globals`
 * catches bare `fetch`. `node:fs` is an import, so it is a pattern.
 */
const NO_AMBIENT = {
  'no-restricted-properties': [
    'error',
    { object: 'Date', property: 'now', message: 'Ports, not globals (§8): take a Clock.' },
    { object: 'Math', property: 'random', message: 'Ports, not globals (§8): take an Ids or Crypto port.' },
    { object: 'crypto', property: 'randomUUID', message: 'Ports, not globals (§8): take an Ids port.' },
    { object: 'process', property: 'env', message: 'Ports, not globals (§8): take a Config.' },
  ],
  'no-restricted-globals': [
    'error',
    { name: 'fetch', message: 'Ports, not globals (§8): take a Net port.' },
  ],
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        { group: ['fs', 'node:fs', 'node:fs/*'], message: 'Ports, not globals (§8): take a FileStore or Storage port.' },
      ],
    },
  ],
};

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'eslint.config.js', 'vitest.config.ts'] },

  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      // §8: `any` is forbidden, boundaries parse `unknown`.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // §8: errors are typed and exhaustive; an empty catch hides a failure.
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-throw-literal': 'error',
      // §8: the size limits. Exceeding one means the design is wrong.
      complexity: ['error', 10],
      'max-lines': ['error', { max: 400, skipBlankLines: false, skipComments: false }],
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: false, skipComments: false }],
      // §8: no TODO/FIXME/XXX in merged work.
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx'], location: 'anywhere' }],
      eqeqeq: ['error', 'always'],
    },
  },

  // The ambient ban applies to all of src/ …
  { files: ['src/**/*.ts'], rules: NO_AMBIENT },

  // … and is lifted only where the nondeterminism is *supposed* to enter.
  // These three files and the fakes are the entire surface, which is what
  // makes the ban auditable by reading four paths.
  {
    files: ['src/substrate/ports.ts', 'src/substrate/clock.ts', 'src/substrate/ids.ts', 'src/substrate/crypto.ts', 'src/substrate/config.ts', 'src/substrate/storage/sqlite.ts', 'src/interface/cli.ts'],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-imports': 'off',
    },
  },

  ...Object.values(layerRules),

  {
    // Tests may be long and may reach for the real clock to prove a fake
    // differs from it. They may not use `any`.
    files: ['test/**/*.ts'],
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-imports': 'off',
    },
  },
);
