"use strict";
/**
 * github-stars-manager-for-utools 存储层 harness(dev-bridge 沙箱内跑)。
 * 以桥的真实 utools dbStorage/dbCryptoStorage 代理(真实执行 + 写日志可还原)直接断言
 * window.githubStarsAPI 的 v2 分片存储、增量 patch、标签/笔记/索引逻辑;
 * 网络层走真实 https(仅 2 个小请求,均为预期失败路径)。
 * 运行:dev_load {path: 本文件, mode:"file", allowHostModules:["https"]} → dev_call runAll
 */
const TARGET = "C:/Users/Administrator/Desktop/ccc/ccc/github-stars-manager-for-utools/preload.js";
require(TARGET);
const api = window.githubStarsAPI;
const ds = utools.dbStorage; // 桥代理:真实执行,便于直接读 gh: 分片/meta 键

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
    if (cond) { pass++; console.log("ok - " + name); }
    else {
        fail++;
        const d = detail === undefined ? "" : " :: " + String(detail).slice(0, 200);
        failures.push(name + d);
        console.log("FAIL - " + name + d);
    }
}
function eq(a, b, name) {
    const ja = JSON.stringify(a), jb = JSON.stringify(b);
    ok(ja === jb, name, ja === jb ? undefined : (ja + " != " + jb).slice(0, 200));
}

const mkRepo = (i, extra) => Object.assign({
    id: i, name: "repo-" + i, fullName: "user" + i + "/repo-" + i,
    owner: { login: "user" + i }, description: "x".repeat(300),
    htmlUrl: "https://github.com/user" + i + "/repo-" + i,
    language: i % 3 === 0 ? "Rust" : "TypeScript", topics: ["cli", "tools"],
    stargazersCount: 1000 + i, customTags: [], starredAt: "2024-06-01T00:00:00Z",
}, extra || {});

function readMeta() { return ds.getItem("gh:repos:meta"); }
function shardSnap(meta) {
    const snap = {};
    for (let i = 0; i < meta.totalShards; i++) snap[i] = ds.getItem(meta.shardPrefix + ":" + i);
    return snap;
}
function joinedParse(meta) {
    let joined = "";
    for (let i = 0; i < meta.totalShards; i++) joined += ds.getItem(meta.shardPrefix + ":" + i);
    return { joined, parsed: (() => { try { return JSON.parse(joined); } catch (e) { return "PARSE_ERR:" + e.message; } })() };
}

async function runAll() {
    const t = async (name, fn) => {
        try { await fn(); }
        catch (e) {
            fail++;
            const msg = (e && (e.stack || e.message)) || String(e);
            failures.push(name + " :: EXC " + String(msg).slice(0, 200));
            console.log("FAIL - " + name + " :: EXC " + String(msg).split("\n").slice(0, 2).join(" | "));
        }
    };

    // 复跑卫生:清掉上一轮遗留的 gh:* 键(均由 harness 首轮创建,桥存储里本无真实数据)
    for (const k of ["gh:repos", "gh:repos:meta", "gh:noteIndex", "gh:tags",
        "gh:note:2", "gh:note:3", "gh:note:4", "gh:note:99"]) ds.removeItem(k);
    api.setSettings({}); api.setToken(null);

    await t("T0 空库基线", async () => {
        eq(api.getRepos(), [], "getRepos []");
        eq(api.getTags(), [], "getTags []");
        eq(api.getSettings(), {}, "getSettings {}");
        ok(api.getToken() == null, "getToken null");
        eq(api.getStoredReleases(), [], "getStoredReleases []");
        ok(api.getSyncState() == null, "getSyncState null");
        eq(api.getAllNotes(), [], "getAllNotes []");
        eq(api.getReleaseSubscriptions(), [], "getReleaseSubscriptions []");
        eq(api.getAiTranslations(), {}, "getAiTranslations {}");
    });

    await t("T1 加密存储 roundtrip", async () => {
        api.setToken("ghp_harness_dummy");
        ok(api.getToken() === "ghp_harness_dummy", "token roundtrip");
        api.setSettings({ theme: "dark", syncInterval: 7, aiModel: "glm-4.7" });
        eq(api.getSettings(), { theme: "dark", syncInterval: 7, aiModel: "glm-4.7" }, "settings roundtrip");
    });

    await t("T2 扁平写入与缓存防突变", async () => {
        const repos = Array.from({ length: 50 }, (_, i) => mkRepo(i));
        api.setRepos(repos);
        const out = api.getRepos();
        ok(out.length === 50, "读回长度 50", out.length);
        ok(out[7].fullName === "user7/repo-7", "字段一致", out[7].fullName);
        ok(readMeta() == null, "小库不写 meta(扁平)");
        ok(Array.isArray(ds.getItem("gh:repos")), "flat 键存数组");
        out[0].name = "MUTATED"; out[0].topics.push("MUT");
        const again = api.getRepos();
        ok(again[0].name === "repo-0", "防对象突变污染缓存");
        ok(again[0].topics.length === 2, "防数组突变", again[0].topics.length);
    });

    await t("T3 patchRepo 扁平增量", async () => {
        api.patchRepo(5, { alias: "我的仓库", customTags: ["t1"] });
        const out = api.getRepos();
        ok(out[5].alias === "我的仓库", "patch 生效");
        ok(out[5].fullName === "user5/repo-5", "原字段保留");
        ok(out[4].alias === undefined && out[6].alias === undefined, "不影响邻居");
        const before = api.getRepos().length;
        api.patchRepo(99999, { x: 1 });
        ok(api.getRepos().length === before, "patch 不存在 id 无副作用");
    });

    await t("T5 分片写入(约 1.2MB > 900KB)", async () => {
        const repos = Array.from({ length: 2000 }, (_, i) => mkRepo(i));
        const totalBytes = Buffer.byteLength(JSON.stringify(repos), "utf8");
        console.log("  [T5] totalBytes=" + totalBytes + " (阈值 " + 900 * 1024 + ")");
        ok(totalBytes > 900 * 1024, "测试数据确超分片阈值", totalBytes);
        api.setRepos(repos);
        const meta = readMeta();
        ok(meta != null && meta.sharded === true, "meta.sharded=true");
        ok(meta.formatVersion === 2, "formatVersion=2", meta.formatVersion);
        ok(meta.totalShards >= 2, "分片数>=2", meta && meta.totalShards);
        ok(ds.getItem("gh:repos") == null, "flat 键已删");
        const { parsed } = joinedParse(meta);
        ok(Array.isArray(parsed), "分片拼接可 JSON.parse", typeof parsed);
        if (Array.isArray(parsed)) {
            ok(parsed.length === 2000, "拼接后 2000 条", parsed.length);
            ok(parsed[0].id === 0 && parsed[1999].id === 1999, "首尾仓库完整落在片内");
        }
        const idx = meta.repoIndex || {};
        ok(Object.keys(idx).length === 2000, "repoIndex 全覆盖", Object.keys(idx).length);
        const out = api.getRepos();
        ok(out.length === 2000, "getRepos 读回 2000", out.length);
        ok(out[1999].fullName === "user1999/repo-1999", "读回末元素一致");
    });

    await t("T6 patchRepo 分片增量(只重写目标片)", async () => {
        const meta0 = readMeta();
        const snap = shardSnap(meta0);
        api.patchRepo(0, { aiSummary: "s".repeat(50) });
        ok(api.getRepos()[0].aiSummary === "s".repeat(50), "patch 生效");
        const meta1 = readMeta();
        ok(meta1.shardPrefix === meta0.shardPrefix, "增量写不轮换 shardPrefix");
        let changed = 0;
        for (let i = 0; i < meta1.totalShards; i++)
            if (snap[i] !== ds.getItem(meta1.shardPrefix + ":" + i)) changed++;
        ok(changed === 1, "只重写 1 片", changed);
    });

    await t("T7 patchReposBatch 跨片批量", async () => {
        const meta0 = readMeta();
        const snap = shardSnap(meta0);
        const byShard = {};
        for (const [id, s] of Object.entries(meta0.repoIndex))
            (byShard[s] = byShard[s] || []).push(Number(id));
        const shards = Object.keys(byShard).map(Number).sort((a, b) => a - b);
        const a = byShard[shards[0]][0];
        const b = byShard[shards[shards.length - 1]][0];
        api.patchReposBatch([{ id: a, patch: { aiTags: ["ta"] } }, { id: b, patch: { aiTags: ["tb"] } }]);
        const out = api.getRepos();
        ok(out[a] && out[a].aiTags && out[a].aiTags[0] === "ta"
            && out[b] && out[b].aiTags && out[b].aiTags[0] === "tb", "批量 patch 生效");
        let changed = 0;
        for (let i = 0; i < meta0.totalShards; i++)
            if (snap[i] !== ds.getItem(meta0.shardPrefix + ":" + i)) changed++;
        ok(changed === Math.min(2, meta0.totalShards), "重写且仅重写受影响分片", changed);
        api.patchReposBatch([]);                                    // 空集 no-op
        api.patchReposBatch([{ id: -1, patch: { x: 1 } }]);         // 全不存在 → changed=false 直接返回
        ok(readMeta().shardPrefix === meta0.shardPrefix, "空批/无命中批不触发写");
    });

    await t("T8 分片膨胀→整库重写回退", async () => {
        const meta0 = readMeta();
        const big = "B".repeat(500 * 1024);
        api.patchRepo(0, { aiSummary: big });
        const meta1 = readMeta();
        ok(meta1.shardPrefix !== meta0.shardPrefix, "超限回退触发整库重写(前缀轮换)");
        ok(api.getRepos()[0].aiSummary === big, "大字段读回一致");
        let stale = 0;
        for (let i = 0; i < meta0.totalShards; i++)
            if (ds.getItem(meta0.shardPrefix + ":" + i) != null) stale++;
        ok(stale === 0, "旧分片键已清理", stale);
        const { parsed } = joinedParse(meta1);
        ok(Array.isArray(parsed) && parsed.length === 2000, "重写后拼接不变量仍成立", Array.isArray(parsed) ? parsed.length : parsed);
    });

    await t("T9 分片→扁平降级(缩库)", async () => {
        api.setRepos(Array.from({ length: 6 }, (_, i) => mkRepo(i)));
        ok(readMeta() == null, "缩库后 meta 清除");
        ok(Array.isArray(ds.getItem("gh:repos")), "回到 flat 键");
        ok(api.getRepos().length === 6, "缩库读回 6");
    });

    await t("T10 标签 CRUD 与 deleteTag 级联剥离", async () => {
        const t1 = api.addTag({ name: "前端", color: "#fff" });
        const t2 = api.addTag({ name: "工具", color: "#000" });
        ok(t1.id && t2.id && t1.id !== t2.id, "addTag 生成唯一 id");
        eq(api.getTags().map(x => x.order), [0, 1], "order 自动递增");
        const up = api.updateTag(t1.id, { name: "前端2" });
        ok(up && up.name === "前端2" && up.updatedAt >= t1.updatedAt, "updateTag 生效");
        ok(api.updateTag("nope", {}) === null, "updateTag 不存在→null");
        api.patchRepo(0, { customTags: [t1.id, t2.id] });
        api.patchRepo(1, { customTags: [t1.id] });
        const r = await api.deleteTag(t1.id);
        eq(r, { updated: 2, errors: 0 }, "deleteTag 返回统计");
        ok(!api.getTags().some(x => x.id === t1.id), "标签定义已删");
        const out = api.getRepos();
        eq(out[0].customTags, [t2.id], "repo0 剥离已删标签");
        eq(out[1].customTags, [], "repo1 剥离后为空");
        const remaining = api.getTags();
        api.reorderTags(remaining.map(x => x.id));
        eq(api.getTags().map(x => x.id), remaining.map(x => x.id), "reorderTags 保序");
        const r2 = await api.deleteTag(t2.id);
        eq(r2, { updated: 1, errors: 0 }, "deleteTag 关联 1 仓");
        eq(api.getTags(), [], "标签清空");
    });

    await t("T11 笔记 CRUD/索引懒建/孤儿清理", async () => {
        ds.removeItem("gh:noteIndex"); // 复位为"老用户无索引"状态,专测懒建哲学
        for (const id of [2, 3, 4, 99]) ds.removeItem("gh:note:" + id);
        ok(ds.getItem("gh:noteIndex") == null, "初始无索引(已复位)");
        const n1 = api.setNote(2, "note-two");
        ok(n1 && n1.content === "note-two" && n1.repoId === 2 && n1.createdAt > 0, "setNote 返回结构");
        ok(ds.getItem("gh:noteIndex") == null, "无索引时 setNote 不新建索引(懒建哲学)");
        eq(api.getAllNotes().map(n => n.repoId), [2], "getAllNotes 首扫建索引并返回");
        ok(Array.isArray(ds.getItem("gh:noteIndex")) && ds.getItem("gh:noteIndex").length === 1, "索引已持久化");
        api.setNote(3, "note-three");
        eq(api.getAllNotes().map(n => n.repoId).sort((x, y) => x - y), [2, 3], "索引驱动读取");
        const oldCreated = api.getNote(2).createdAt;
        api.setNote(2, "note-two-v2");
        ok(api.getNote(2).content === "note-two-v2" && api.getNote(2).createdAt === oldCreated, "复写保留 createdAt");
        api.setNotes([{ repoId: 4, content: "imported", createdAt: 111, updatedAt: 111 }]);
        ok(api.getNote(4) && api.getNote(4).createdAt === 111, "setNotes 原样导入保留时间戳");
        api.setNote(99, "orphan"); // 99 不在当前 repos(0..5)→ 孤儿候选
        api.setRepos([{ id: 0, name: "only", fullName: "u/only" }]);
        const all2 = api.getAllNotes();
        ok(!all2.some(n => n.repoId === 99) && api.getNote(99) == null, "孤儿笔记被清理");
        eq(all2.map(n => n.repoId), [], "仅剩 id0 库中无笔记(2/3/4 均成孤儿清理)");
        api.deleteNote(4);
        ok(true, "deleteNote 幂等安全(4 已被清理)");
    });

    await t("T12 stub 路径(桥默认 stub 的副作用 API)", async () => {
        const oe = api.openExternal("https://github.com");
        ok(oe === undefined || (oe && oe.stubbed === true), "openExternal 被 stub 不真开浏览器", JSON.stringify(oe).slice(0, 80));
        const sn = api.showNotification("hi");
        ok(sn === undefined || (sn && sn.stubbed === true), "showNotification 被 stub 不真弹通知", JSON.stringify(sn).slice(0, 80));
        api.abortAiCall();
        ok(true, "abortAiCall 无 in-flight 时不抛");
        let threw = null;
        try { await api.analyzeRepo("# readme", { fullName: "a/b", description: "", language: "TypeScript" }); }
        catch (e) { threw = e; }
        ok(threw instanceof Error, "analyzeRepo 在 utools.ai stub 下按 R2 抛错(不吞)", threw && threw.message);
        const models = await api.getAIModels();
        ok(models === undefined || Array.isArray(models), "getAIModels 不抛(桥 stub 分歧容忍)", typeof models);
    });

    await t("T13 真实 HTTPS 失败路径(结构化错误)", async () => {
        let err = null;
        try { await api.checkRateLimit("definitely-invalid-token-harness"); } catch (e) { err = e; }
        ok(err !== null, "无效 token → reject", err && err.message);
        ok(err && (err.status === 401 || err.status === 403
            || (err.status === undefined && /network|timeout|ENOTFOUND|ETIMEDOUT/i.test(err.message || ""))),
            "err.status 结构化(401/403)或网络层错误", err && err.status);
        console.log("  [net] checkRateLimit err.status=" + (err && err.status) + " msg=" + (err && err.message));
        const rd = await api.getReadme("nonexistent-owner-xyz", "nonexistent-repo-xyz", "definitely-invalid-token-harness");
        ok(rd === null, "getReadme 失败路径 → null(不抛)");
    });

    console.log("==== HARNESS DONE pass=" + pass + " fail=" + fail + " ====");
    return { pass, fail, failures: failures.slice(0, 30) };
}

exports.runAll = runAll;
exports.probe = () => ({ target: TARGET, keys: Object.keys(api).length });
