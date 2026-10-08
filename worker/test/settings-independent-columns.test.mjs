// studio_settings has three columns that arrive in separate hand-run migrations
// (default_extra_max, transfer_info, pick_link_message). Each must read on its
// own: a database that has run the pick_link_message ALTER but not the S2
// transfer_info one must still return the saved message. (It once fell back
// past pick_link_message because the read assumed the migrations ran in order,
// so admin.html showed the built-in default after the template was saved.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { s2Schema, envOf, call, SECRET, rows } from './guest-order-helpers.mjs';

const settings = (env, body) => call(env, '/api/admin/settings', { method: body ? 'PUT' : 'GET', token: SECRET, body });
const MSG = 'hi,\n{專案名稱} {連結}';
// has pick_link_message, lacks transfer_info
const cut = settings => () => s2Schema({ orders: [], items: [], settings, index: false });
const NO_TRANSFER = cut(['transfer_info']);

test('transfer_info missing, pick_link_message present: the saved message reads back', async () => {
  const env = envOf({ schema: NO_TRANSFER() });
  assert.equal((await settings(env, { pick_link_message: MSG })).status, 200);
  assert.equal(rows(env, 'SELECT pick_link_message FROM studio_settings')[0].pick_link_message, MSG);
  const got = await (await settings(env)).json();
  assert.equal(got.pick_link_message, MSG);
  assert.equal(got.transfer_info, null);
});

test('default_extra_max present, transfer_info missing: both still read', async () => {
  const env = envOf({ schema: NO_TRANSFER() });
  await settings(env, { default_extra_max: 5, pick_link_message: MSG });
  const got = await (await settings(env)).json();
  assert.equal(got.default_extra_max, 5);
  assert.equal(got.pick_link_message, MSG);
});

test('pick_link_message missing, the other two present: they still read', async () => {
  const env = envOf({ schema: cut(['pick_link_message'])() });
  await settings(env, { default_extra_max: 7 });
  const got = await (await settings(env)).json();
  assert.equal(got.default_extra_max, 7);
  assert.equal(got.pick_link_message, null);
});

test('default_extra_max missing, pick_link_message present: the message still reads', async () => {
  const env = envOf({ schema: cut(['default_extra_max', 'transfer_info'])() });
  await settings(env, { pick_link_message: MSG });
  const got = await (await settings(env)).json();
  assert.equal(got.pick_link_message, MSG);
  assert.equal(got.transfer_info, null);
});

test('all three missing: the base fields read and the three are null', async () => {
  const env = envOf({ schema: cut(['default_extra_max', 'transfer_info', 'pick_link_message'])() });
  const res = await settings(env);
  assert.equal(res.status, 200);
  const got = await res.json();
  assert.equal(got.pick_link_message, null);
  assert.equal(got.transfer_info, null);
});
