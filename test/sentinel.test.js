import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditLogEvent, ChannelType, Collection, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { createBackup } from '../src/backup.js';
import { SlidingWindowCounter } from '../src/counter.js';
import { createGuard } from '../src/guard.js';
import { disableLockdown, enableLockdown } from '../src/lockdown.js';
import { createRaid } from '../src/raid.js';
import { Store } from '../src/store.js';

const BOT = '100000000000000001';
const OWNER = '100000000000000002';
const MASTER = '100000000000000003';
const TRUSTED = '100000000000000004';
const ROGUE = '100000000000000005';
const G = 'g1';

let seq = 5000n;
const entry = (action, executorId, targetId = 't1', changes = [], extra = {}) => ({
  id: String(++seq),
  action,
  executorId,
  targetId,
  changes,
  createdTimestamp: Date.now(),
  ...extra,
});

function setup({ monitor = false, graded = true, banFails = false } = {}) {
  const calls = { bans: [], unbans: [], deleted: [], dms: [], logs: [], patches: [], roleSets: [], roleAdds: [], roleRemoves: [], permSets: [], created: [] };
  const logChannel = { isTextBased: () => true, send: async (m) => (calls.logs.push({ ...m.embeds[0].data, components: m.components }), m) };
  const channels = new Collection([['log', logChannel]]);
  const roles = new Collection();
  const members = new Collection();

  const addRole = (id, bits = 0n, extra = {}) => {
    const role = {
      id,
      managed: false,
      editable: true,
      permissions: new PermissionsBitField(bits),
      setPermissions: async (p) => calls.permSets.push([id, p]),
      delete: async () => calls.deleted.push(`role:${id}`),
      ...extra,
    };
    roles.set(id, role);
    return role;
  };
  const addMember = (id, roleIds = [], bot = false) => {
    const m = {
      id,
      user: { bot },
      permissions: { has: () => false },
      roles: {
        cache: new Collection(roleIds.map((r) => [r, roles.get(r)])),
        set: async (ids) => calls.roleSets.push([id, ids]),
        add: async (ids) => calls.roleAdds.push([id, ids]),
        remove: async (ids) => calls.roleRemoves.push([id, ids]),
      },
    };
    members.set(id, m);
    return m;
  };
  const guild = {
    id: G,
    name: 'Test',
    ownerId: OWNER,
    bans: {
      create: async (id) => {
        if (banFails) throw new Error('Missing Permissions');
        calls.bans.push(id);
      },
      remove: async (id) => calls.unbans.push(id),
    },
    members: {
      cache: members,
      fetch: async (id) => {
        if (id === undefined) return members;
        if (!members.has(id)) throw new Error('Unknown Member');
        return members.get(id);
      },
    },
    channels: { cache: channels, fetch: async () => null },
    roles: { cache: roles, fetch: async () => null },
  };
  const client = {
    user: { id: BOT },
    users: { send: async (id) => calls.dms.push(id) },
    fetchWebhook: async (id) => ({ delete: async () => calls.deleted.push(`webhook:${id}`) }),
    rest: { patch: async (route, opts) => calls.patches.push([route, opts.body]) },
  };
  const store = new Store();
  store.set(G, 'logChannelId', 'log');
  store.set(G, 'monitor', monitor);
  store.set(G, 'graded', graded);
  store.addWhitelist(G, TRUSTED, MASTER);
  const counter = new SlidingWindowCounter(600_000);
  const config = { masterAdmins: new Set([MASTER]), breakerLimit: 10, memberBreakerLimit: 20, breakerWindowMs: 600_000, autoLockdown: false, membersIntent: true };
  const backup = createBackup({ store });
  const guard = createGuard({ client, store, counter, config, backup });
  const addChannel = (id) => channels.set(id, { delete: async () => calls.deleted.push(`channel:${id}`) });
  addRole('r1');
  addMember(ROGUE, ['r1']);
  return { guard, guild, store, counter, calls, backup, addChannel, addRole, addMember, roles, channels };
}

test('kayan pencere: süresi dolan vuruşlar düşer', () => {
  const c = new SlidingWindowCounter(1000);
  assert.equal(c.hit('k', 0), 1);
  assert.equal(c.hit('k', 500), 2);
  assert.equal(c.hit('k', 1200), 2);
  assert.equal(c.count('k', 5000), 0);
});

test('kademeli ceza: karantina + geri alma; Affet rolleri geri verir', async () => {
  const s = setup();
  s.addChannel('c9');
  await s.guard.handleAuditEntry(entry(AuditLogEvent.ChannelCreate, ROGUE, 'c9'), s.guild);
  assert.deepEqual(s.calls.bans, []);
  assert.deepEqual(s.calls.roleSets, [[ROGUE, []]]);
  assert.deepEqual(s.calls.deleted, ['channel:c9']);
  assert.deepEqual(s.store.getQuarantine(G, ROGUE).roles, ['r1']);
  const ids = s.calls.logs[0].components[0].components.map((c) => c.data.custom_id);
  assert.deepEqual(ids, [`sg:act:forgive:${ROGUE}`, `sg:act:ban:${ROGUE}`]);

  assert.match(await s.guard.forgive(s.guild, ROGUE), /1\/1 rol/);
  assert.deepEqual(s.calls.roleAdds, [[ROGUE, ['r1']]]);
  assert.equal(s.store.getQuarantine(G, ROGUE), null);
});

test('kademeli ceza kapalıysa ya da üye yoksa doğrudan ban', async () => {
  const a = setup({ graded: false });
  await a.guard.handleAuditEntry(entry(AuditLogEvent.RoleCreate, ROGUE), a.guild);
  assert.deepEqual(a.calls.bans, [ROGUE]);
  const b = setup();
  await b.guard.handleAuditEntry(entry(AuditLogEvent.RoleCreate, '999'), b.guild); // sunucuda değil
  assert.deepEqual(b.calls.bans, ['999']);
});

test('izleme modu: hiçbir işlem yapılmaz, yalnızca loglanır', async () => {
  const s = setup({ monitor: true });
  s.addChannel('c9');
  await s.guard.handleAuditEntry(entry(AuditLogEvent.ChannelCreate, ROGUE, 'c9'), s.guild);
  for (let i = 0; i < 12; i++) await s.guard.handleAuditEntry(entry(AuditLogEvent.ChannelDelete, TRUSTED), s.guild);
  assert.deepEqual([s.calls.bans, s.calls.roleSets, s.calls.deleted, s.calls.dms], [[], [], [], []]);
  assert.equal(s.store.isWhitelisted(G, TRUSTED), true);
  assert.match(s.calls.logs[0].title, /İZLEME/);
  assert.ok(s.store.recentIncidents(G, 5).some((i) => /İZLEME.*DEVRE KESİCİ/.test(i.type)));
});

test('whitelist / master / bot / sahip cezalandırılmaz', async () => {
  const s = setup();
  for (const id of [TRUSTED, MASTER, BOT, OWNER]) {
    await s.guard.handleAuditEntry(entry(AuditLogEvent.ChannelCreate, id), s.guild);
    await s.guard.handleAuditEntry(entry(AuditLogEvent.BotAdd, id), s.guild);
  }
  assert.deepEqual([s.calls.bans, s.calls.roleSets], [[], []]);
});

test('kapsamlı ve süreli whitelist', async () => {
  const s = setup();
  const SCOPED = '100000000000000006';
  const EXPIRED = '100000000000000007';
  s.addMember(SCOPED);
  s.addMember(EXPIRED);
  s.store.addWhitelist(G, SCOPED, MASTER, { scopes: ['channels'] });
  s.store.addWhitelist(G, EXPIRED, MASTER, { expiresAt: Date.now() - 1 });
  await s.guard.handleAuditEntry(entry(AuditLogEvent.ChannelCreate, SCOPED), s.guild);
  assert.deepEqual(s.calls.roleSets, []);
  await s.guard.handleAuditEntry(entry(AuditLogEvent.BotAdd, SCOPED, 'evilbot'), s.guild); // kapsam dışı
  assert.deepEqual(s.calls.roleSets, [[SCOPED, []]]);
  assert.deepEqual(s.calls.bans, ['evilbot']);
  await s.guard.handleAuditEntry(entry(AuditLogEvent.ChannelCreate, EXPIRED), s.guild); // süresi dolmuş
  assert.equal(s.calls.roleSets.length, 2);
});

test('devre kesici (silme): whitelist üyesi 11. silmede ban + kalıcı iptal + DM + geri yükle butonu', async () => {
  const s = setup();
  s.store.upsertSnapshot(G, 'channel', 't1', { name: 'x' });
  for (let i = 0; i < 10; i++) {
    await s.guard.handleAuditEntry(entry(i % 2 ? AuditLogEvent.RoleDelete : AuditLogEvent.ChannelDelete, TRUSTED), s.guild);
  }
  assert.deepEqual(s.calls.bans, []);
  await s.guard.handleAuditEntry(entry(AuditLogEvent.EmojiDelete, TRUSTED), s.guild);
  assert.deepEqual(s.calls.bans, [TRUSTED]);
  assert.equal(s.store.isWhitelisted(G, TRUSTED), false);
  assert.equal(s.store.isRevoked(G, TRUSTED), true);
  assert.deepEqual(s.calls.dms.sort(), [OWNER, MASTER].sort());
  const last = s.calls.logs.at(-1);
  assert.match(last.title, /DEVRE KESİCİ/);
  assert.deepEqual(
    last.components[0].components.map((c) => c.data.custom_id),
    [`sg:act:unban:${TRUSTED}`, `sg:act:restore:${TRUSTED}`],
  );
});

test('devre kesici (ban/kick): 20 serbest, 21.de ban; prune ağırlıklı sayılır; master da kapsamda', async () => {
  const s = setup();
  for (let i = 0; i < 20; i++) await s.guard.handleAuditEntry(entry(AuditLogEvent.MemberBanAdd, TRUSTED), s.guild);
  assert.deepEqual(s.calls.bans, []);
  await s.guard.handleAuditEntry(entry(AuditLogEvent.MemberKick, TRUSTED), s.guild);
  assert.deepEqual(s.calls.bans, [TRUSTED]);
  await s.guard.handleAuditEntry(entry(AuditLogEvent.MemberPrune, MASTER, null, [], { extra: { removed: 500 } }), s.guild);
  assert.deepEqual(s.calls.bans, [TRUSTED, MASTER]);
});

test('taç sahibi asla cezalandırılmaz, silmeleri etiketli loglanır', async () => {
  const s = setup();
  for (let i = 0; i < 15; i++) await s.guard.handleAuditEntry(entry(AuditLogEvent.ChannelDelete, OWNER), s.guild);
  for (let i = 0; i < 30; i++) await s.guard.handleAuditEntry(entry(AuditLogEvent.MemberBanAdd, OWNER), s.guild);
  assert.deepEqual(s.calls.bans, []);
  assert.equal(s.calls.logs.length, 16); // 15 silme + 1 toplu ban uyarısı
  assert.match(s.calls.logs[0].title, /TAÇ SAHİBİ İŞLEMİ/);
  assert.match(s.calls.logs[14].title, /TOPLU İŞLEM/);
});

test('aynı kayıt iki kez gelirse bir kez işlenir; eşzamanlı ihlalde tek yaptırım', async () => {
  const s = setup();
  const e = entry(AuditLogEvent.RoleCreate, ROGUE);
  await s.guard.handleAuditEntry(e, s.guild);
  await s.guard.handleAuditEntry(e, s.guild);
  assert.equal(s.calls.logs.length, 1);
  await Promise.all(Array.from({ length: 5 }, () => s.guard.handleAuditEntry(entry(AuditLogEvent.RoleCreate, ROGUE), s.guild)));
  assert.equal(s.calls.roleSets.length, 1);
});

test('yetki yükseltme: role tehlikeli izin eklenmesi geri alınır', async () => {
  const s = setup();
  const perm = (o, n) => [{ key: 'permissions', old: String(o), new: String(n) }];
  await s.guard.handleAuditEntry(entry(AuditLogEvent.RoleUpdate, ROGUE, 'r1', perm(0n, P.Administrator)), s.guild);
  assert.deepEqual(s.calls.permSets, [['r1', 0n]]);
  assert.equal(s.calls.roleSets.length, 1);
  await s.guard.handleAuditEntry(entry(AuditLogEvent.RoleUpdate, ROGUE, 'r1', perm(0n, P.SendMessages)), s.guild); // zararsız
  await s.guard.handleAuditEntry(entry(AuditLogEvent.RoleUpdate, TRUSTED, 'r1', perm(0n, P.BanMembers)), s.guild); // güvenilir
  assert.equal(s.calls.permSets.length, 1);
  s.addRole(G); // @everyone: whitelist üyesi için de geri alınır, ceza yok
  await s.guard.handleAuditEntry(entry(AuditLogEvent.RoleUpdate, TRUSTED, G, perm(1024n, 1024n | P.ManageRoles)), s.guild);
  assert.deepEqual(s.calls.permSets[1], [G, 1024n]);
  assert.equal(s.calls.roleSets.length, 1);
  assert.deepEqual(s.calls.bans, []);
});

test('yetki yükseltme: tehlikeli rol verilmesi geri alınır', async () => {
  const s = setup();
  s.addRole('admin', P.Administrator);
  s.addMember('victim');
  const add = (id) => [{ key: '$add', new: [{ id, name: id }] }];
  await s.guard.handleAuditEntry(entry(AuditLogEvent.MemberRoleUpdate, ROGUE, 'victim', add('r1')), s.guild); // zararsız rol
  assert.deepEqual(s.calls.roleRemoves, []);
  await s.guard.handleAuditEntry(entry(AuditLogEvent.MemberRoleUpdate, ROGUE, 'victim', add('admin')), s.guild);
  assert.deepEqual(s.calls.roleRemoves, [['victim', ['admin']]]);
  assert.equal(s.calls.roleSets.length, 1);
  await s.guard.handleAuditEntry(entry(AuditLogEvent.MemberRoleUpdate, TRUSTED, 'victim', add('admin')), s.guild);
  assert.equal(s.calls.roleRemoves.length, 1);
});

test('vanity: whitelist üyesi -> yalnızca geri alınır; yabancı -> geri al + yaptırım; sahip -> serbest', async () => {
  const s = setup();
  const ch = [{ key: 'vanity_url_code', old: 'eski', new: 'yeni' }];
  await s.guard.handleAuditEntry(entry(AuditLogEvent.GuildUpdate, TRUSTED, G, ch), s.guild);
  assert.deepEqual(s.calls.patches, [[`/guilds/${G}/vanity-url`, { code: 'eski' }]]);
  assert.deepEqual(s.calls.roleSets, []);
  await s.guard.handleAuditEntry(entry(AuditLogEvent.GuildUpdate, ROGUE, G, ch), s.guild);
  assert.equal(s.calls.roleSets.length, 1);
  await s.guard.handleAuditEntry(entry(AuditLogEvent.GuildUpdate, OWNER, G, ch), s.guild);
  await s.guard.handleAuditEntry(entry(AuditLogEvent.GuildUpdate, ROGUE, G, [{ key: 'name' }]), s.guild);
  assert.equal(s.calls.patches.length, 2);
});

test('ban ve rol sökme başarısızsa açıkça raporlanır', async () => {
  const s = setup({ banFails: true });
  await s.guard.handleAuditEntry(entry(AuditLogEvent.MemberKick, '999'), s.guild);
  assert.match(s.store.recentIncidents(G)[0].result, /MANUEL MÜDAHALE/);
});

test('kopukluk telafisi: ilk açılışta imleç kurulur, sonra kaçan kayıtlar işlenir', async () => {
  const s = setup();
  s.guild.fetchAuditLogs = async () => {
    throw new Error('çağrılmamalı');
  };
  assert.equal(await s.guard.catchUp(s.guild), 0);
  const cursor = BigInt(s.store.get(G, 'lastAuditId'));
  const missed = [entry(AuditLogEvent.RoleCreate, ROGUE), entry(AuditLogEvent.ChannelCreate, TRUSTED)].map((e, i) => ({
    ...e,
    id: String(cursor + BigInt(i + 1)),
  }));
  s.guild.fetchAuditLogs = async ({ after }) => {
    assert.equal(after, String(cursor));
    return { entries: new Collection(missed.map((e) => [e.id, e]).reverse()) };
  };
  assert.equal(await s.guard.catchUp(s.guild), 2);
  assert.equal(s.calls.roleSets.length, 1);
  assert.equal(s.store.get(G, 'lastAuditId'), missed[1].id);
});

test('botun kendini koruması: yetki kaybında master adminlere alarm', async () => {
  const s = setup();
  let admin = true;
  s.guild.members.me = { permissions: { has: () => admin }, roles: { highest: { id: 'bot-role' } } };
  s.roles.get('r1').comparePositionTo = () => -1;
  s.addRole('high', P.Administrator, { comparePositionTo: () => -1 });
  await s.guard.checkHealth(s.guild); // başlangıç durumu
  assert.equal(s.calls.dms.length, 0);
  admin = false;
  s.roles.get('high').comparePositionTo = () => 1;
  await s.guard.checkHealth(s.guild);
  assert.deepEqual(s.calls.dms.sort(), [OWNER, MASTER].sort());
  assert.match(s.calls.logs.at(-1).title, /KORUMA ZAYIFLADI/);
});

test('yedek: silinen rol ve kanallar yeni kimliklerle, bağları korunarak geri yüklenir', async () => {
  const s = setup();
  s.store.upsertSnapshot(G, 'role', 'oldrole', { name: 'Mod', color: 1, hoist: true, mentionable: false, permissions: '8', position: 3, members: ['m1', 'm2'] });
  s.store.upsertSnapshot(G, 'channel', 'oldcat', { name: 'Kategori', type: ChannelType.GuildCategory, parentId: null, position: 0, overwrites: [] });
  s.store.upsertSnapshot(G, 'channel', 'oldtext', {
    name: 'sohbet',
    type: ChannelType.GuildText,
    parentId: 'oldcat',
    position: 1,
    topic: 'konu',
    overwrites: [
      { id: 'oldrole', type: 0, allow: '1024', deny: '0' },
      { id: 'gone-role', type: 0, allow: '0', deny: '1024' },
    ],
  });
  s.store.upsertSnapshot(G, 'channel', 'other', { name: 'başkası', type: 0, position: 2, overwrites: [] });
  for (const [kind, id] of [['role', 'oldrole'], ['channel', 'oldcat'], ['channel', 'oldtext']]) s.store.markDeleted(G, kind, id, ROGUE);
  s.store.markDeleted(G, 'channel', 'other', TRUSTED);
  s.store.upsertSnapshot(G, 'channel', 'oldtext', { name: 'ÜZERİNE YAZILMAMALI' }); // silinen görüntü donmuştur

  const roleAdds = [];
  s.guild.members.me = { roles: { highest: { position: 10 } } };
  s.guild.members.addRole = async (o) => roleAdds.push(o.user);
  s.guild.roles.create = async (o) => {
    s.roles.set('newrole', { id: 'newrole' });
    s.calls.created.push(['role', o]);
    return { id: 'newrole' };
  };
  s.guild.channels.create = async (o) => {
    const id = `new-${o.name}`;
    s.channels.set(id, { id });
    s.calls.created.push(['channel', o]);
    return { id };
  };
  assert.equal(s.backup.restorableCount(G, ROGUE), 3);
  const res = await s.backup.restoreDeletedBy(s.guild, ROGUE);
  assert.deepEqual([res.roles, res.channels, res.failed, res.members], [1, 2, 0, 2]);
  const [role, cat, text] = s.calls.created.map((c) => c[1]);
  assert.deepEqual([role.name, role.permissions, role.position], ['Mod', 8n, 3]);
  assert.equal(cat.name, 'Kategori');
  assert.deepEqual([text.name, text.parent, text.topic], ['sohbet', 'new-Kategori', 'konu']);
  assert.deepEqual(text.permissionOverwrites, [{ id: 'newrole', type: 0, allow: 1024n, deny: 0n }]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(roleAdds, ['m1', 'm2']);
  assert.equal(s.backup.restorableCount(G, ROGUE), 0); // ikinci kez geri yüklenmez
});

test('raid: eşik aşılınca raid modu, dalga atılır, sonra eski seviye geri gelir', async () => {
  const s = setup();
  const kicked = [];
  const levels = [];
  s.guild.verificationLevel = 1;
  s.guild.setVerificationLevel = async (l) => levels.push(l);
  const raid = createRaid({ store: s.store, guard: s.guard });
  const join = async (i) => {
    const m = { id: `j${i}`, guild: s.guild, user: { bot: false, createdTimestamp: 0 }, permissions: { has: () => false }, kick: async () => kicked.push(`j${i}`) };
    s.guild.members.cache.set(m.id, m);
    await raid.onJoin(m);
  };
  for (let i = 0; i < 9; i++) await join(i);
  assert.equal(s.store.get(G, 'raidState'), null);
  await join(9);
  assert.equal(kicked.length, 10);
  assert.deepEqual(levels, [4]);
  await join(10); // raid modunda yeni katılan da atılır
  assert.equal(s.store.get(G, 'raidState').kicked, 11);
  assert.match(await raid.endRaid(s.guild, MASTER), /11/);
  assert.deepEqual(levels, [4, 1]);
  assert.equal(s.store.get(G, 'raidState'), null);
});

test('raid: izleme modunda ve hesap yaşı filtresinde davranış', async () => {
  const s = setup({ monitor: true });
  const kicked = [];
  const raid = createRaid({ store: s.store, guard: s.guard });
  const mk = (i, created = 0) => ({ id: `j${i}`, guild: s.guild, user: { bot: false, createdTimestamp: created }, kick: async () => kicked.push(i) });
  for (let i = 0; i < 15; i++) await raid.onJoin(mk(i));
  assert.equal(kicked.length, 0);
  assert.equal(s.store.get(G, 'raidState'), null);
  assert.equal(s.calls.logs.filter((l) => /Raid Algılandı/.test(l.title)).length, 1);

  s.store.set(G, 'monitor', false);
  s.store.set(G, 'raidJoins', 100);
  s.store.set(G, 'minAccountAgeDays', 7);
  await raid.onJoin(mk('new', Date.now()));
  await raid.onJoin(mk('old', 0));
  assert.deepEqual(kicked, ['new']);
});

test('depo: onay istekleri süreyle sınırlı ve tek kullanımlık', () => {
  const store = new Store();
  const id = store.addApproval(G, 'wl_add', { userId: 'x' }, MASTER, 60_000);
  assert.deepEqual(store.getApproval(G, id).payload, { userId: 'x' });
  assert.equal(store.getApproval('baska', id), null);
  store.deleteApproval(id);
  assert.equal(store.getApproval(G, id), null);
  assert.equal(store.getApproval(G, store.addApproval(G, 'lock', {}, MASTER, -1)), null);
});

test('lockdown: izinleri kapatır ve önceki durumu birebir geri yükler', async () => {
  const VIEW = 1n << 10n;
  const SEND = 1n << 11n;
  const mk = (id, allow, deny) => {
    const ow = { allow, deny };
    return {
      id,
      isThread: () => false,
      state: ow,
      permissionOverwrites: {
        cache: { get: () => ({ allow: { has: (b) => (ow.allow & b) === b }, deny: { has: (b) => (ow.deny & b) === b } }) },
        edit: async (_id, p) => {
          for (const [name, bit] of [['ViewChannel', VIEW], ['SendMessages', SEND]]) {
            ow.allow &= ~bit;
            ow.deny &= ~bit;
            if (p[name] === true) ow.allow |= bit;
            if (p[name] === false) ow.deny |= bit;
          }
        },
      },
    };
  };
  const a = mk('a', SEND, 0n);
  const b = mk('b', 0n, VIEW);
  const c = mk('c', 0n, 0n);
  const guild = { id: G, channels: { cache: new Map([['a', a], ['b', b], ['c', c]]) } };
  const store = new Store();

  const on = await enableLockdown(guild, store, { by: 'u', reason: 'test' });
  assert.equal(on.ok, 3);
  for (const ch of [a, b, c]) assert.equal(ch.state.deny, VIEW | SEND);
  assert.equal((await enableLockdown(guild, store, { by: 'u', reason: 'x' })).already, true);

  const off = await disableLockdown(guild, store, { reason: 'test' });
  assert.equal(off.ok, 3);
  assert.deepEqual([a.state.allow, a.state.deny], [SEND, 0n]);
  assert.deepEqual([b.state.allow, b.state.deny], [0n, VIEW]);
  assert.deepEqual([c.state.allow, c.state.deny], [0n, 0n]);
  assert.equal(store.get(G, 'lockdown'), null);
});
