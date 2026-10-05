// Browser suites: registration (shoot date and type) and the admin shoot columns / folder picker.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { ADMIN, SHOOT_CLIENTS, adminMock } from '../lib/auth-mocks.mjs';

export default async function register() {

// ═══════════════════════════════════════════════════════════════════════════
// 拍攝日期 / 拍攝類型 — collected at registration so the photographer stops
// guessing which R2 folder a new account belongs to, and editable afterwards
// because clients fill them in wrong.
// ═══════════════════════════════════════════════════════════════════════════

function registerMock() {
  const seen = [];
  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      seen.push({ path: new URL(req.url()).pathname, method: req.method(), body: req.postData() });
      return route.fulfill({ status: 201, contentType: 'application/json',
        body: '{"success":true,"message":"等待管理員審核"}' });
    });
  };
  return { seen, attach };
}

const lastRegister = m => {
  const posts = m.seen.filter(r => r.method === 'POST' && r.path === '/api/auth/register');
  return posts.length ? JSON.parse(posts[posts.length - 1].body || '{}') : null;
};

// Opens the register form and fills the three fields that already existed, so
// each test below only has to say what it does differently. Returns nothing —
// what it did is asserted through what reaches the Worker.
const fillBasics = async page => {
  await page.click('.register-toggle');
  await page.fill('#reg-name', '王小明');
  await page.fill('#reg-email', 'w@example.com');
  await page.fill('#reg-password', 'secret1');
};

{
  const m = registerMock();
  await suite('registration — the shoot date and type are asked for and sent',
    `${base}/client-login.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fillBasics(page);

      // Both controls have to be on screen, not merely in the document: this
      // form spends its life display:none behind the login panel.
      const shown = await page.evaluate(() => {
        const box = id => {
          const el = document.getElementById(id);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { w: r.width, h: r.height, display: getComputedStyle(el).display };
        };
        return { date: box('reg-shoot-date'), type: box('reg-shoot-type'), tbd: box('reg-shoot-tbd') };
      });
      ok('the date picker is on screen', !!shown.date && shown.date.h > 0, JSON.stringify(shown.date));
      ok('so is the type control', !!shown.type && shown.type.h > 0, JSON.stringify(shown.type));
      ok('and the 未定 option', !!shown.tbd && shown.tbd.h > 0, JSON.stringify(shown.tbd));

      // every category, in the order the constant lists them, and nothing else
      const opts = await page.evaluate(() => ({
        shown: [...document.querySelectorAll('#reg-shoot-type option')]
          .map(o => o.value).filter(Boolean),
        constant: typeof SHOOT_TYPES === 'undefined' ? null : SHOOT_TYPES,
      }));
      ok('the type list is exactly the shared constant',
        JSON.stringify(opts.shown) === JSON.stringify(opts.constant || []),
        `${JSON.stringify(opts.shown)} vs ${JSON.stringify(opts.constant)}`);
      ok('and it holds the six categories asked for',
        JSON.stringify(opts.shown) === JSON.stringify(['婚紗', '婚禮', '親子', '個人', '活動', '其他']),
        JSON.stringify(opts.shown));

      await page.selectOption('#reg-shoot-type', '婚紗');
      await page.fill('#reg-shoot-date', '2026-08-19');
      await page.click('#reg-btn');
      await page.waitForTimeout(400);

      const body = lastRegister(m);
      ok('registering reached the Worker', !!body, JSON.stringify(m.seen));
      ok('carrying the shoot date', body?.shoot_date === '2026-08-19', JSON.stringify(body));
      ok('and the shoot type', body?.shoot_type === '婚紗', JSON.stringify(body));
      ok('alongside what it always carried',
        body?.name === '王小明' && body?.email === 'w@example.com' && body?.password === 'secret1',
        JSON.stringify(body));
      return out;
    },
    { before: m.attach });
}

{
  const m = registerMock();
  await suite('registration — 未定 is an answer, and 其他 can be typed',
    `${base}/client-login.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fillBasics(page);

      // 其他 is the only entry that opens a box, so the box must not be there
      // before it is chosen
      const beforeOther = await page.evaluate(() => {
        const el = document.getElementById('reg-shoot-type-other');
        return el ? el.getBoundingClientRect().height : 0;
      });
      ok('the free-text box is hidden until 其他 is chosen', beforeOther === 0, String(beforeOther));

      await page.selectOption('#reg-shoot-type', '其他');
      await page.waitForTimeout(100);
      const afterOther = await page.evaluate(() => {
        const el = document.getElementById('reg-shoot-type-other');
        return el ? el.getBoundingClientRect().height : 0;
      });
      ok('choosing 其他 opens it', afterOther > 0, String(afterOther));

      await page.fill('#reg-shoot-type-other', '寵物寫真');
      await page.check('#reg-shoot-tbd');
      await page.waitForTimeout(100);
      const dateDisabled = await page.evaluate(() =>
        document.getElementById('reg-shoot-date')?.disabled);
      ok('ticking 未定 takes the date picker out of play', dateDisabled === true, String(dateDisabled));

      await page.click('#reg-btn');
      await page.waitForTimeout(400);
      const body = lastRegister(m);
      // '' would be indistinguishable from the accounts that were never asked,
      // and the photographer would chase a client who has already answered
      ok('未定 is sent as itself, not as an empty date', body?.shoot_date === '未定', JSON.stringify(body));
      ok('and the typed category is sent as the type', body?.shoot_type === '寵物寫真', JSON.stringify(body));
      return out;
    },
    { before: m.attach });
}

{
  const m = registerMock();
  await suite('registration — an unanswered shoot question is refused, not sent blank',
    `${base}/client-login.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fillBasics(page);
      await page.click('#reg-btn');
      await page.waitForTimeout(300);
      ok('nothing reached the Worker', lastRegister(m) === null, JSON.stringify(m.seen));
      const err = await page.evaluate(() => document.getElementById('reg-err')?.textContent || '');
      ok('and the client is told which answer is missing',
        err.includes('拍攝日期') || err.includes('拍攝類型'), err);

      // one answer at a time, or the other guard covers for the missing one
      await page.selectOption('#reg-shoot-type', '婚紗');
      await page.click('#reg-btn');
      await page.waitForTimeout(300);
      ok('answering only the type is still refused', lastRegister(m) === null, JSON.stringify(m.seen));
      const errDate = await page.evaluate(() => document.getElementById('reg-err')?.textContent || '');
      ok('and the missing date is the one named', errDate.includes('拍攝日期'), errDate);

      // 其他 with nothing typed is the same gap wearing a different hat
      await page.fill('#reg-shoot-date', '2026-08-19');
      await page.selectOption('#reg-shoot-type', '其他');
      await page.click('#reg-btn');
      await page.waitForTimeout(300);
      ok('choosing 其他 without typing one is refused too', lastRegister(m) === null, JSON.stringify(m.seen));
      const err2 = await page.evaluate(() => document.getElementById('reg-err')?.textContent || '');
      ok('and says so', err2.includes('拍攝類型'), err2);
      return out;
    },
    { before: m.attach });
}

{
  const m = adminMock({ clients: SHOOT_CLIENTS });
  await suite('admin — the shoot date and type are on the row, and an empty one says 未填',
    `${base}/admin.html#clients`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('#clients-tbody tr').length >= 3,
        null, { timeout: 6000 }).catch(() => {});

      const seen = await page.evaluate(() => {
        const q = (id, sel) => document.querySelector(`tr[data-id="${id}"] ${sel}`);
        // height, not merely presence: a control in the wrong container, or
        // behind a display:none, is one the photographer cannot use
        const tall = el => (el ? el.getBoundingClientRect().height > 0 : false);
        const dateCell = id => {
          const input = q(id, '[data-shoot-date]');
          const tbd = q(id, '[data-shoot-tbd]');
          return {
            value: input ? input.value : null,
            shown: tall(input),
            tbd: tbd ? tbd.checked : null,
            // 未填 is rendered on every row and shown on the empty ones, so
            // this is the state of the mark and not whether it exists
            unfilled: tall(q(id, '[data-shoot-date-unfilled]')),
            raw: q(id, '[data-shoot-date-raw]')?.textContent ?? null,
          };
        };
        const typeCell = id => {
          const sel = q(id, '[data-shoot-type]');
          const other = q(id, '[data-shoot-type-other]');
          return {
            value: sel ? sel.value : null,
            label: sel?.selectedOptions[0]?.textContent ?? null,
            shown: tall(sel),
            other: other ? other.value : null,
            otherShown: tall(other),
          };
        };
        return {
          d1: dateCell(1), t1: typeCell(1),
          d2: dateCell(2), t2: typeCell(2),
          d3: dateCell(3), t3: typeCell(3),
          d4: dateCell(4),
          options: [...document.querySelectorAll('tr[data-id="1"] [data-shoot-type] option')]
            .map(o => o.value).filter(Boolean),
          constant: typeof SHOOT_TYPES === 'undefined' ? null : SHOOT_TYPES,
          headers: [...document.querySelectorAll('#clients-table thead th')].map(th => th.textContent.trim()),
          bodyCols: document.querySelector('#clients-tbody tr')?.children.length ?? 0,
        };
      });

      ok('the table has a 拍攝日期 column', seen.headers.includes('拍攝日期'), JSON.stringify(seen.headers));
      ok('and a 拍攝類型 column', seen.headers.includes('拍攝類型'), JSON.stringify(seen.headers));
      ok('and every row has a cell for each header',
        seen.bodyCols === seen.headers.length, `${seen.bodyCols} cells vs ${seen.headers.length} headers`);
      // the same one line adds a category to both pages, or it is not one line
      ok('the admin list is the shared constant too',
        JSON.stringify(seen.options) === JSON.stringify(seen.constant || []),
        `${JSON.stringify(seen.options)} vs ${JSON.stringify(seen.constant)}`);

      ok('a filled date is shown on the row, and on screen',
        seen.d1.value === '2026-08-19' && seen.d1.shown, JSON.stringify(seen.d1));
      ok('a filled type is shown on the row, and on screen',
        seen.t1.value === '婚紗' && seen.t1.shown, JSON.stringify(seen.t1));
      ok('a filled account is neither marked 未填 nor ticked 未定',
        seen.d1.unfilled === false && seen.d1.tbd === false, JSON.stringify(seen.d1));
      ok('and its free-text box stays shut', seen.t1.otherShown === false, JSON.stringify(seen.t1));

      // The point of 未填: an account nobody asked must look different from an
      // account that answered, and different from one that answered 未定.
      ok('an account with neither is marked 未填 on the date',
        seen.d2.unfilled === true, JSON.stringify(seen.d2));
      ok('and reads 未填 on the type', seen.t2.value === '' && seen.t2.label === '未填',
        JSON.stringify(seen.t2));
      ok('with the date control empty rather than defaulted to today',
        seen.d2.value === '' && seen.d2.tbd === false, JSON.stringify(seen.d2));

      ok('an account that answered 未定 is ticked, not marked 未填',
        seen.d3.tbd === true && seen.d3.unfilled === false, JSON.stringify(seen.d3));
      ok('and 未定 is not passed off as a date', seen.d3.value === '', JSON.stringify(seen.d3));
      // 寵物寫真 is not in the list, so it has to come back through 其他
      ok('a typed category comes back as 其他 plus the text, box open',
        seen.t3.value === '其他' && seen.t3.other === '寵物寫真' && seen.t3.otherShown,
        JSON.stringify(seen.t3));

      // hand-written into D1 and parseable as neither: shown, not swallowed
      ok('a date that is neither is still put in front of the photographer',
        seen.d4.raw === '2026-08-19 上午' && seen.d4.unfilled === false, JSON.stringify(seen.d4));
      ok('and is not fed to the date input as if it parsed',
        seen.d4.value === '', JSON.stringify(seen.d4));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

const permPuts = m => m.seen.filter(r => r.method === 'PUT' && /permissions$/.test(r.path));
const lastPut = m => {
  const puts = permPuts(m);
  return puts.length ? { path: puts[puts.length - 1].path, body: JSON.parse(puts[puts.length - 1].body || '{}') } : null;
};

{
  const m = adminMock({ clients: SHOOT_CLIENTS });
  await suite('admin — the photographer can correct both fields',
    `${base}/admin.html#clients`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('#clients-tbody tr').length >= 3,
        null, { timeout: 6000 }).catch(() => {});

      await page.selectOption('tr[data-id="1"] [data-shoot-type]', '親子');
      await page.waitForTimeout(400);
      let put = lastPut(m);
      ok('changing the type saves it', put?.body.shoot_type === '親子', JSON.stringify(put));
      ok('against that client', put?.path === '/api/admin/clients/1/permissions', JSON.stringify(put));
      ok('and does not send folders, which would be read as "none"',
        put?.body.folders === undefined, JSON.stringify(put?.body));
      // the route writes permissions from whatever body it is handed, so a
      // partial save has to carry the toggles as they stand
      ok('and carries the toggles as they stand, rather than clearing them',
        put?.body.can_book === true && put?.body.can_upload === false, JSON.stringify(put?.body));

      await page.fill('tr[data-id="2"] [data-shoot-date]', '2026-09-01');
      await page.waitForTimeout(400);
      put = lastPut(m);
      ok('setting a date on an unfilled account saves it',
        put?.body.shoot_date === '2026-09-01', JSON.stringify(put));
      ok('against that client', put?.path === '/api/admin/clients/2/permissions', JSON.stringify(put));

      await page.check('tr[data-id="2"] [data-shoot-tbd]');
      await page.waitForTimeout(400);
      put = lastPut(m);
      ok('ticking 未定 saves the answer rather than a blank',
        put?.body.shoot_date === '未定', JSON.stringify(put));
      const dateEl = () => page.evaluate(() =>
        document.querySelector('tr[data-id="2"] [data-shoot-date]')?.disabled);
      ok('and takes the date control out of play, so the two cannot disagree',
        (await dateEl()) === true, String(await dateEl()));
      await page.uncheck('tr[data-id="2"] [data-shoot-tbd]');
      await page.waitForTimeout(400);
      ok('unticking it hands the date control back', (await dateEl()) === false, String(await dateEl()));

      const before = permPuts(m).length;
      await page.selectOption('tr[data-id="1"] [data-shoot-type]', '其他');
      await page.waitForTimeout(400);
      // 其他 on its own is not a category, and saving it would put an empty
      // string over whatever the client had said
      ok('choosing 其他 with nothing typed saves nothing yet',
        permPuts(m).length === before, JSON.stringify(permPuts(m).map(r => r.body)));

      await page.fill('tr[data-id="1"] [data-shoot-type-other]', '謝師宴');
      // a text box commits when the photographer leaves it, the way every
      // other text box in a browser does
      await page.keyboard.press('Tab');
      await page.waitForTimeout(400);
      put = lastPut(m);
      ok('a typed category is saved as the text, not as 其他',
        put?.body.shoot_type === '謝師宴', JSON.stringify(permPuts(m).map(r => r.body)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // Folder names are typed by hand, so the rule keys on the whole date and
  // nothing less: 20260901/ is a different day and 2026/ is half the bucket.
  const m = adminMock({
    clients: SHOOT_CLIENTS,
    tree: {
      // 120260819 and 20260819000 carry the eight digits inside a longer
      // number, which is not this date and not a date at all
      '': ['20260901/', '20260819/', '2026/', '2026-08-19 王小明/', '20260819-other/',
           '120260819/', '20260819000/'],
      '20260819/': ['20260819/Anita/', '20260819/20260819 二進/'],
    },
  });
  await suite('admin — the folder picker puts the shoot date’s folders first',
    `${base}/admin.html#clients`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('#clients-tbody tr').length >= 3,
        null, { timeout: 6000 }).catch(() => {});

      const read = async id => {
        await page.evaluate(i => {
          document.querySelector(`tr[data-id="${i}"] [data-add-folder]`)?.click();
        }, id);
        await page.waitForTimeout(500);
        return page.evaluate(() => ({
          order: [...document.querySelectorAll('[data-pick-folder]')].map(el => el.dataset.pickFolder),
          marked: [...document.querySelectorAll('.folder-pick-row')]
            .filter(r => r.hasAttribute('data-date-match'))
            .map(r => r.querySelector('[data-pick-folder]')?.dataset.pickFolder),
          // a marker nobody can read is not a hint
          markText: [...document.querySelectorAll('.folder-pick-row[data-date-match]')]
            .map(r => r.textContent.trim()),
          // nothing may be hidden — a folder the rule missed is still the one
          // the photographer wants
          sizes: [...document.querySelectorAll('.folder-pick-row')].map(r => {
            const b = r.getBoundingClientRect();
            return { w: Math.round(b.width), h: Math.round(b.height), display: getComputedStyle(r).display };
          }),
          head: document.getElementById('folder-picker-head-hint')?.textContent || '',
        }));
      };
      const close = () => page.click('#folder-picker-close');

      const one = await read(1);
      ok('every folder in the bucket is still offered', one.order.length === 7, JSON.stringify(one.order));
      ok('and none of them is hidden',
        one.sizes.length === 7 && one.sizes.every(s => s.h > 0 && s.display !== 'none'),
        JSON.stringify(one.sizes));
      ok('the folders naming the shoot date come first',
        JSON.stringify(one.order.slice(0, 3).sort()) ===
          JSON.stringify(['20260819-other/', '20260819/', '2026-08-19 王小明/'].sort()),
        JSON.stringify(one.order));
      ok('and exactly those are marked',
        JSON.stringify([...one.marked].sort()) ===
          JSON.stringify(['20260819-other/', '20260819/', '2026-08-19 王小明/'].sort()),
        JSON.stringify(one.marked));
      ok('a folder naming another day is neither first nor marked',
        one.order.slice(3).includes('20260901/') && !one.marked.includes('20260901/'),
        JSON.stringify(one.order));
      ok('and a year-only folder is not treated as a match',
        !one.marked.includes('2026/'), JSON.stringify(one.marked));
      ok('nor is the date buried inside a longer number',
        !one.marked.includes('120260819/') && !one.marked.includes('20260819000/'),
        JSON.stringify(one.marked));
      ok('the mark says what it means', one.markText.length === 3 &&
        one.markText.every(t => t.includes('拍攝日')), JSON.stringify(one.markText));
      ok('and the picker says which date it is keying on',
        one.head.includes('2026-08-19'), one.head);

      // Stepping inside a matching folder: every child sits under the date, so
      // a rule reading the whole path would mark the lot and say nothing.
      await page.click('[data-browse="20260819/"]');
      await page.waitForTimeout(500);
      const inside = await page.evaluate(() => ({
        order: [...document.querySelectorAll('[data-pick-folder]')].map(el => el.dataset.pickFolder),
        marked: [...document.querySelectorAll('.folder-pick-row[data-date-match]')]
          .map(r => r.querySelector('[data-pick-folder]')?.dataset.pickFolder),
      }));
      ok('inside a matching folder, both children are offered',
        inside.order.length === 2, JSON.stringify(inside.order));
      ok('and only the one whose own name carries the date is marked',
        JSON.stringify(inside.marked) === JSON.stringify(['20260819/20260819 二進/']),
        JSON.stringify(inside.marked));
      await close();

      // no date is no hint — and the order stays as the bucket gave it
      const two = await read(2);
      ok('an account with no shoot date gets no marks', two.marked.length === 0, JSON.stringify(two.marked));
      ok('and the bucket order is left alone',
        JSON.stringify(two.order) === JSON.stringify(['20260901/', '20260819/', '2026/',
          '2026-08-19 王小明/', '20260819-other/', '120260819/', '20260819000/']),
        JSON.stringify(two.order));
      await close();

      // 未定 is an answer, but it is not a date, and it must not be read as one
      const three = await read(3);
      ok('「未定」 suggests nothing', three.marked.length === 0, JSON.stringify(three.marked));
      ok('and leaves every folder on offer', three.order.length === 7, JSON.stringify(three.order));
      await close();

      // 2026-08-19 上午 is not a date. Reading one out of it would suggest
      // folders off a value the photographer has been told to go and fix.
      const four = await read(4);
      ok('a date with anything else in it suggests nothing',
        four.marked.length === 0, JSON.stringify(four.marked));
      await close();

      // A correction has to reach the picker, or it keeps suggesting folders
      // for the date the client got wrong.
      await page.fill('tr[data-id="2"] [data-shoot-date]', '2026-09-01');
      await page.waitForTimeout(400);
      const fixed = await read(2);
      ok('a corrected date is the one the picker keys on',
        fixed.head.includes('2026-09-01') && JSON.stringify(fixed.marked) === '["20260901/"]',
        `${fixed.head} / ${JSON.stringify(fixed.marked)}`);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}
}
