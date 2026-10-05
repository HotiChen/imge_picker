# Browser suites (`test/`)

Real-Chromium tests for what only a browser can show: layout, touch, canvas, themes,
and the pages' behaviour against fake Workers. The Worker's own tests are separate
(`node --test "worker/test/*.test.mjs"`).

```
NODE_PATH=/opt/node-tools/node_modules node test/run.mjs            # everything (minutes)
ONLY='guest picking' NODE_PATH=/opt/node-tools/node_modules node test/run.mjs
```

(Outside the cloud session Playwright lives at `/tmp/pwinstall/node_modules`.)

## Layout

| Path | What |
|---|---|
| `run.mjs` | The runner: imports the harness, imports every `suites/*.mjs` in file-name order and calls its default export, then closes the browser and prints the summary / exit code. Nothing else belongs here. |
| `lib/harness.mjs` | Starts the static file server (`base`) and Chromium (`browser`), defines `suite()`, holds the counters (`stats.failed`, `stats.ran`) and `ONLY`. |
| `lib/env.mjs` | Plain shared constants and helpers: `ROOT`, `PIXEL`, `MOBILE`, touch gestures (`swipeTouch`, `pinchTouch`, `realTouch` ...), `BIG_PHOTO`, `CANVAS_PX`. |
| `lib/*.mjs` (others) | Fakes and helpers used by **more than one** suite file: `pick-fake.mjs` (`pickFakeWorker`, the fake Worker most suites build on), `auth-mocks.mjs`, `editor-mocks.mjs`, `orders-fake.mjs`, `delivery-helpers.mjs`, `album-world.mjs`, ... |
| `suites/NN-<topic>.mjs` | The suites, grouped by topic. Helpers used by one file only stay at the top of that file. |

Suites run in file-name order, and the order inside a file is the order they are written.
The numbers only fix the order; a new file may take any unused number (or a letter suffix
such as `16a-` to run right after `16-`).

## Adding a suite

1. Create a new file `test/suites/NN-<topic>.mjs`. Do not append to an existing file
   unless your suite really belongs to that topic: parallel agents adding suites to the
   same file conflict, separate files do not.
2. Export one async function that registers the suites:

   ```js
   // Browser suites: <one line on the topic>.
   import { base, suite } from '../lib/harness.mjs';
   import { MOBILE } from '../lib/env.mjs';
   import { pickFakeWorker } from '../lib/pick-fake.mjs';

   export default async function register() {
     const m = pickFakeWorker({ /* ... */ });
     await suite('topic — what must be true',          // the name is what ONLY= matches
       `${base}/index.html?t=TOK`,                      // page to open
       async page => {                                  // returns the result lines
         const out = [];
         const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
         ok('something', true);
         return out;
       },
       { before: m.attach, initScript: /* ... */, contextOptions: MOBILE });
   }
   ```

   `run.mjs` picks the file up by itself: there is no list to edit.
3. A line starting with `FAIL` counts as a failure; so does a page error or a thrown
   suite. A suite that returns no `ok` line proves nothing: assert the positive case too
   (see the false-pass shapes in `CLAUDE.md`).
4. Declare helpers, constants and fixtures at the top of `register()` (before their first
   use). Only when a **second** file needs one, move it to `lib/` (an existing topical file
   or a new one), `export` it and import it where used; never copy a helper between files.
   Lib files must not import from `suites/`.
5. Suites are in-order scripts sharing one browser: never leave global state behind
   (routes, storage, timers) outside the context `suite()` opens for you.

## `ONLY`

`ONLY=<text>[|<text>...]` runs only the suites whose **name** contains one of the texts
(plain substring, `|` separates alternatives). Skipped suites print nothing; the run ends
with `(ONLY="...": N suites ran, the rest were skipped)`. A filter that matches no suite
fails the run. Use it while developing; run everything before a commit or merge.

Known flaky under load (re-run alone with `ONLY=` before calling it a regression) is
listed in `CLAUDE.md`.
