import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Collection } from 'discord.js';
import { createBackup } from '../src/backup.js';
import { SlidingWindowCounter } from '../src/counter.js';
import { createGuard } from '../src/guard.js';
import { createInteractionHandler } from '../src/interactions.js';
import { createRaid } from '../src/raid.js';
import { Store } from '../src/store.js';
import { actionRow, confirmView, incidentsView, logEmbed, passwordModal, raidModal, settingsView, whitelistView } from '../src/ui.js';

const OWNER = '100000000000000002';
const M1 = '100000000000000003';
const M2 = '100000000000000008';
const USER = '100000000000000009';
const G = 'g1';

function setup() {
  const sent = [];
  const logChannel = {
    id: 'log',
    isTextBased: () => true,
    isThread: () => false,
    permissionOverwrites: { cache: { get: () => undefined }, edit: async () => {} },
    send: async (m) => (sent.push(m), m),
  };
  const channels = new Collection([['log', logChannel]]);
  const members = new Collection();
  const roles = new Collection();
  const unbans = [];
  const guild = {
    id: G,
    name: 'Test',
    ownerId: OWNER,
    members: {
      cache: members,
      me: { permissions: { has: () => true }, roles: { highest: {} } },
      fetch: async (id) => (id === undefined ? members : members.get(id) ?? Promise.reject(new Error('Unknown Member'))),
    },
    channels: { cache: channels },
    roles: { cache: roles },
    bans: { create: async () => {}, remove: async (id) => unbans.push(id) },
  };
  const client = { user: { id: 'bot' }, users: { send: async () => {} }, ws: { ping: 42 }, uptime: 1000 };
  const store = new Store();
  store.set(G, 'logChannelId', 'log');
  const counter = new SlidingWindowCounter(600_000);
  const config = { masterAdmins: new Set([M1, M2]), breakerLimit: 10, memberBreakerLimit: 20, breakerWindowMs: 600_000, lockdownPassword: null, membersIntent: true };
  const backup = createBackup({ store });
  const guard = createGuard({ client, store, counter, config, backup });
  const raid = createRaid({ store, guard });
  const ctx = { client, store, counter, config, guard, backup, raid };
  const handle = createInteractionHandler(ctx);

  const base = (userId, kind) => {
    const i = {
      guild,
      user: { id: userId, tag: `u${userId}` },
      channel: logChannel,
      deferred: false,
      replied: false,
      out: [],
      inCachedGuild: () => true,
      isChatInputCommand: () => kind === 'command',
      isButton: () => kind === 'button',
      isChannelSelectMenu: () => false,
      isMessageComponent: () => kind === 'button',
      isModalSubmit: () => kind === 'modal',
      isFromMessage: () => true,
      reply: async (v) => ((i.replied = true), i.out.push(['reply', v])),
      update: async (v) => ((i.replied = true), i.out.push(['update', v])),
      editReply: async (v) => i.out.push(['editReply', v]),
      followUp: async (v) => i.out.push(['followUp', v]),
      deferReply: async () => ((i.deferred = true), i.out.push(['deferReply'])),
      deferUpdate: async () => ((i.deferred = true), i.out.push(['deferUpdate'])),
      showModal: async (m) => i.out.push(['modal', m]),
    };
    return i;
  };
  const click = async (userId, customId, message) => {
    const i = Object.assign(base(userId, 'button'), { customId, message });
    await handle(i);
    return i;
  };
  const command = async (userId, sub, opts = {}) => {
    const i = Object.assign(base(userId, 'command'), {
      commandName: 'guard',
      options: { getSubcommand: () => sub, getUser: () => opts.user, getString: (k) => opts[k] ?? null },
    });
    await handle(i);
    return i;
  };
  const text = (i) => JSON.stringify(i.out.at(-1)[1]?.embeds?.map((e) => e.toJSON?.() ?? e) ?? i.out.at(-1)[1]);
  const lastApprovalId = () => sent.at(-1).components[0].components[0].data.custom_id.split(':')[3];
  return { guild, store, ctx, sent, unbans, members, roles, click, command, text, lastApprovalId, handle, base };
}

test('çift onay: whitelist ekleme ikinci master onayına kadar uygulanmaz', async () => {
  const s = setup();
  const i = await s.command(M1, 'whitelist', { islem: 'add', user: { id: USER }, kapsam: 'channels', sure: '3600' });
  assert.match(s.text(i), /İkinci Onay Bekleniyor/);
  assert.equal(s.store.isWhitelisted(G, USER), false);
  const id = s.lastApprovalId();

  const self = await s.click(M1, `sg:apr:ok:${id}`);
  assert.match(self.out[0][1].content, /Kendi isteğinizi/);
  assert.equal(s.store.isWhitelisted(G, USER), false);

  const outsider = await s.click(USER, `sg:apr:ok:${id}`);
  assert.match(outsider.out[0][1].content, /whitelist üyeleri ve Master/);

  const ok = await s.click(M2, `sg:apr:ok:${id}`);
  assert.match(s.text(ok), /Onaylandı/);
  const e = s.store.whitelistEntry(G, USER);
  assert.deepEqual([e.scopes, e.addedBy], [['channels'], M1]);
  assert.ok(e.expiresAt > Date.now() + 3_500_000);
  assert.equal(s.store.isWhitelisted(G, USER, 'roles'), false);

  const again = await s.click(M2, `sg:apr:ok:${id}`); // tek kullanımlık
  assert.match(s.text(again), /İstek Geçersiz/);
});

test('çift onay: reddedilen istek uygulanmaz; sunucu sahibi muaftır', async () => {
  const s = setup();
  await s.command(M1, 'whitelist', { islem: 'add', user: { id: USER } });
  await s.click(M2, `sg:apr:no:${s.lastApprovalId()}`);
  assert.equal(s.store.isWhitelisted(G, USER), false);
  const i = await s.command(OWNER, 'whitelist', { islem: 'add', user: { id: USER } });
  assert.match(s.text(i), /eklendi/);
  assert.equal(s.store.isWhitelisted(G, USER), true);
  const rm = await s.command(M1, 'whitelist', { islem: 'remove', user: { id: USER } }); // çıkarma onaysız
  assert.match(s.text(rm), /çıkarıldı/);
});

test('ayarlar: güçlendiren değişiklik anında, zayıflatan değişiklik onayla', async () => {
  const s = setup();
  assert.equal(s.store.get(G, 'monitor'), true); // varsayılan: izleme modu
  await s.click(M1, 'sg:set:monitor'); // korumayı aç -> onaysız
  assert.equal(s.store.get(G, 'monitor'), false);
  const back = await s.click(M1, 'sg:set:monitor'); // izlemeye dön -> onay gerekir
  assert.equal(s.store.get(G, 'monitor'), false);
  assert.match(s.text(back), /İkinci Onay/);
  await s.click(M2, `sg:apr:ok:${s.lastApprovalId()}`);
  assert.equal(s.store.get(G, 'monitor'), true);
  await s.click(M1, 'sg:set:dual');
  assert.equal(s.store.get(G, 'dual'), true); // çift onayı kapatmak da onaya tabi
  await s.click(OWNER, 'sg:set:dual');
  assert.equal(s.store.get(G, 'dual'), false);
  await s.click(M1, 'sg:set:hack');
  assert.equal(s.store.get(G, 'hack'), undefined);
});

test('yetki: whitelist üyesi paneli görür ama yönetemez; yabancı hiçbirini kullanamaz', async () => {
  const s = setup();
  s.store.addWhitelist(G, USER, OWNER);
  const panel = await s.command(USER, 'panel');
  assert.match(s.text(panel), /Güvenlik Paneli/);
  for (const id of ['sg:settings', 'sg:set:monitor', 'sg:ok:lock:on', 'sg:ok:reset', `sg:act:ban:${M1}`, 'sg:raidcfg']) {
    const i = await s.click(USER, id);
    assert.match(i.out[0][1].content, /yalnızca Master Adminlere/, id);
  }
  assert.equal(s.store.get(G, 'lockdown'), null);
  const stranger = await s.command('555', 'panel');
  assert.match(stranger.out[0][1].content, /whitelist üyeleri ve Master/);
});

test('lockdown: kilitlemek anında, kaldırmak ikinci onayla', async () => {
  const s = setup();
  const on = await s.click(M1, 'sg:ok:lock:on');
  assert.match(s.text(on), /Sunucu Kilitlendi/);
  assert.ok(s.store.get(G, 'lockdown'));
  const off = await s.click(M1, 'sg:ok:lock:off');
  assert.match(s.text(off), /İkinci Onay/);
  assert.ok(s.store.get(G, 'lockdown'));
  await s.click(M2, `sg:apr:ok:${s.lastApprovalId()}`);
  assert.equal(s.store.get(G, 'lockdown'), null);
});

test('log butonları: karar mesaja işlenir, kullanılan butonlar kalkar', async () => {
  const s = setup();
  const message = {
    embeds: [logEmbed('critical', 'Olay', ['x']).toJSON()],
    components: actionRow({ uid: USER, kind: 'ban', restorable: true }).map((r) => r.toJSON()),
  };
  message.components = message.components.map((r) => ({ components: r.components.map((c) => ({ ...c, customId: c.custom_id })) }));
  const i = await s.click(M1, `sg:act:unban:${USER}`, message);
  assert.deepEqual(s.unbans, [USER]);
  const view = i.out.at(-1)[1];
  assert.match(view.embeds[0].toJSON().fields[0].value, /Ban kaldırıldı/);
  assert.deepEqual(
    view.components.flatMap((r) => r.toJSON().components.map((c) => c.custom_id)),
    [`sg:act:restore:${USER}`],
  );
});

test('raid eşikleri modalı doğrulanır', async () => {
  const s = setup();
  const submit = async (vals) => {
    const i = Object.assign(s.base(M1, 'modal'), { customId: 'sg:raidcfg', fields: { getTextInputValue: (k) => vals[k] } });
    await s.handle(i);
    return i;
  };
  const bad = await submit({ joins: '2', window: '60', age: '0' });
  assert.match(bad.out[0][1].content, /Geçersiz/);
  assert.equal(s.store.get(G, 'raidJoins'), 10);
  await submit({ joins: '25', window: '30', age: '3' });
  assert.deepEqual([s.store.get(G, 'raidJoins'), s.store.get(G, 'raidWindowSec'), s.store.get(G, 'minAccountAgeDays')], [25, 30, 3]);
});

test('tüm görünümler Discord sınırları içinde derlenir', () => {
  const s = setup();
  for (let i = 0; i < 23; i++) s.store.addWhitelist(G, `2000000000000000${String(i).padStart(2, '0')}`, OWNER, { scopes: ['roles'], expiresAt: Date.now() + 1e6 });
  s.store.addIncident(G, { type: 'x'.repeat(300), executorId: OWNER, result: 'y'.repeat(2000) });
  const views = [settingsView(s.guild, s.ctx), whitelistView(s.guild, s.ctx, 2), incidentsView(s.guild, s.ctx), confirmView('lock', false), confirmView('reset')];
  for (const v of views) {
    for (const e of v.embeds) e.toJSON();
    for (const c of v.components) assert.ok(c.toJSON().components.length <= 5);
  }
  passwordModal('on').toJSON();
  raidModal(s.store.settings(G)).toJSON();
});
