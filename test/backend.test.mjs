import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { activate } from "../plugin/backend.mjs";

const TASK = "1ec04ced-4b87-44f6-a296-beee80777941";
const MODEL_URL = `https://tripo-data.rg1.data.tripo3d.com/tripo-studio/${TASK}/pbr.glb?sig=1`;
const PREVIEW_URL = `https://tripo-data.rg1.data.tripo3d.com/tripo-studio/${TASK}/render.webp`;

/** A fake Studio host that records every call and keeps jobs and the key in memory. */
function fakeHost(root, game, key = "tsk_test") {
  const jobs = new Map();
  const calls = [];
  const delivered = [];
  const state = { key, saved: key };
  const host = async (method, args) => {
    calls.push(method);
    switch (method) {
      case "credentials.session":
        return state.key;
      case "credentials.read":
        return state.saved;
      case "credentials.write":
        state.saved = state.key = args.token;
        return;
      case "credentials.clear":
        state.saved = state.key = null;
        return;
      case "storage.root":
        return root;
      case "jobs.read":
        return jobs.get(args.id) ?? null;
      case "jobs.write":
        jobs.set(args.id, structuredClone(args.value));
        return true;
      case "assets.deliver": {
        const files = (await readdir(args.output)).sort().map((f) => `assets/tripo/${args.jobId}/${f}`);
        delivered.push(...files);
        return files;
      }
      default:
        throw new Error(`unexpected host call ${method}`);
    }
  };
  const stop = new AbortController();
  const ctx = { project: "demo", directory: game, threadId: "t", callId: 1, signal: stop.signal, host };
  return { ctx, jobs, calls, delivered, state, stop };
}

/**
 * Route fetch to canned Tripo answers; `statuses` is consumed one poll at a time.
 * `poll` replaces the task answer, `file` the download answer, and `taskId` the id Tripo reports.
 */
function fakeTripo({ statuses = ["success"], output, poll, file, taskId = TASK } = {}) {
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    // Header values are checked the way real fetch checks them.
    new Headers(init.headers);
    requests.push({ url, method: init.method ?? "GET", body: init.body, auth: init.headers?.Authorization });
    const json = (data) => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
    if (url.endsWith("/user/balance")) return json({ balance: 1200, frozen: 0 });
    if (url.endsWith("/upload/sts")) return json({ image_token: "img-token" });
    if (url.endsWith("/task") && init.method === "POST") return json({ task_id: TASK });
    if (url.includes(`/task/${TASK}`)) {
      if (poll) return poll(init);
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      return json({
        task_id: taskId,
        type: "text_to_model",
        status,
        progress: status === "success" ? 100 : 50,
        output: status === "success" ? (output ?? { pbr_model: MODEL_URL, rendered_image: PREVIEW_URL }) : {},
      });
    }
    if (url.startsWith("https://tripo-data.")) return file ? file(url, init) : new Response(new Uint8Array([1, 2, 3]));
    return new Response("not found", { status: 404 });
  };
  return requests;
}

const realFetch = globalThis.fetch;
let root;
let game;
beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), "tripo-plugin-"));
  root = path.join(base, "storage");
  game = path.join(base, "game");
  await mkdir(root);
  await mkdir(game);
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("generate submits once, records the task before waiting and delivers model and preview", async () => {
  const requests = fakeTripo({ statuses: ["running", "success"] });
  const { ctx, jobs, calls, delivered } = fakeHost(root, game);
  const plugin = await activate(/** @type {any} */ ({}));
  const result = await plugin.tool("generate", { operation: "text_to_model", prompt: "a wooden crate", options: '{"face_limit":5000,"type":"x"}' }, ctx);

  const submits = requests.filter((r) => r.method === "POST" && r.url.endsWith("/task"));
  assert.equal(submits.length, 1);
  assert.deepEqual(JSON.parse(submits[0].body), { face_limit: 5000, type: "text_to_model", prompt: "a wooden crate" });
  assert.equal(submits[0].auth, "Bearer tsk_test");
  assert.ok(calls.indexOf("jobs.write") < calls.indexOf("assets.deliver"), "task recorded before delivery");
  assert.equal(result.status, "success");
  assert.deepEqual(result.files, [`assets/tripo/${TASK}/model.glb`, `assets/tripo/${TASK}/preview.webp`]);
  assert.deepEqual(delivered, result.files);
  assert.equal(jobs.get("index")[0].taskId, TASK);
});

test("retrieve of a delivered task returns the recorded files without downloading again", async () => {
  fakeTripo();
  const { ctx, delivered } = fakeHost(root, game);
  const plugin = await activate(/** @type {any} */ ({}));
  await plugin.tool("generate", { operation: "text_to_model", prompt: "crate" }, ctx);
  const requests = fakeTripo();
  const again = await plugin.tool("retrieve", { id: TASK.toUpperCase() }, ctx);

  assert.equal(requests.filter((r) => r.url.startsWith("https://tripo-data.")).length, 0);
  assert.equal(requests.filter((r) => r.method === "POST").length, 0);
  assert.deepEqual(again.files, delivered);
});

test("a result on a host outside Tripo's domains is refused", async () => {
  fakeTripo({ output: { model: "https://evil.example/model.glb" } });
  const { ctx } = fakeHost(root, game);
  const plugin = await activate(/** @type {any} */ ({}));
  await assert.rejects(plugin.tool("generate", { operation: "text_to_model", prompt: "x" }, ctx), /not a Tripo host/);
});

test("a task without files reports Tripo's output", async () => {
  fakeTripo({ output: { riggable: true, rig_type: "biped" } });
  const { ctx } = fakeHost(root, game);
  const plugin = await activate(/** @type {any} */ ({}));
  const result = await plugin.tool("generate", { operation: "animate_prerigcheck", id: TASK }, ctx);
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.output, { riggable: true, rig_type: "biped" });
});

test("image_to_model uploads a project image and refuses paths outside the game", async () => {
  const requests = fakeTripo();
  await mkdir(path.join(game, "art"));
  await writeFile(path.join(game, "art", "hero.png"), new Uint8Array([137, 80, 78, 71]));
  const { ctx } = fakeHost(root, game);
  const plugin = await activate(/** @type {any} */ ({}));
  await plugin.tool("generate", { operation: "image_to_model", image: "art/hero.png" }, ctx);
  const submit = requests.find((r) => r.method === "POST" && r.url.endsWith("/task"));
  assert.deepEqual(JSON.parse(submit.body).file, { type: "png", file_token: "img-token" });

  for (const image of ["../outside.png", "/etc/hosts.png", ".git/x.png", "node_modules/a.png"])
    await assert.rejects(plugin.tool("generate", { operation: "image_to_model", image }, ctx), /project-relative/);
});

test("tools fail with a clear message while the key is locked, and status still answers", async () => {
  fakeTripo();
  const { ctx } = fakeHost(root, game, null);
  const plugin = await activate(/** @type {any} */ ({}));
  await assert.rejects(plugin.tool("generate", { operation: "text_to_model", prompt: "x" }, ctx), /press Connect/);
  assert.equal((await plugin.tool("status", {}, ctx)).connected, false);
});

test("connect checks a new key with Tripo before saving it, and disconnect clears it", async () => {
  const requests = fakeTripo();
  const { ctx, state } = fakeHost(root, game, null);
  const plugin = await activate(/** @type {any} */ ({}));
  assert.deepEqual(await plugin.action("connect", {}, ctx), { connected: false, needsKey: true });
  await assert.rejects(plugin.action("connect", { token: "sk-wrong" }, ctx), /tsk_/);
  assert.equal(state.saved, null);

  const answer = await plugin.action("connect", { token: " tsk_new " }, ctx);
  assert.equal(answer.connected, true);
  assert.equal(state.saved, "tsk_new");
  assert.equal(requests.at(-1).auth, "Bearer tsk_new");

  await plugin.action("disconnect", {}, ctx);
  assert.equal(state.saved, null);
});

test("status shows only the key's last four characters", async () => {
  fakeTripo();
  const { ctx } = fakeHost(root, game, "tsk_secret9f2c");
  const plugin = await activate(/** @type {any} */ ({}));
  const state = await plugin.tool("status", {}, ctx);
  assert.equal(state.keyHint, "9f2c");
  assert.doesNotMatch(JSON.stringify(state), /secret/);
});

/** Run a tool call on mocked timers, ticking one poll at a time until it settles. */
async function onMockedClock(start) {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    let settled = false;
    const call = start();
    call.then(
      () => (settled = true),
      () => (settled = true),
    );
    while (!settled) {
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(3_000);
    }
    return await call;
  } finally {
    mock.timers.reset();
  }
}

test("a task still running when generate returns is delivered by a later retrieve", async () => {
  const statuses = ["running"];
  fakeTripo({ statuses });
  const { ctx, delivered } = fakeHost(root, game);
  const plugin = await activate(/** @type {any} */ ({}));
  const first = await onMockedClock(() => plugin.tool("generate", { operation: "text_to_model", prompt: "crate" }, ctx));
  assert.equal(first.status, "running");
  assert.match(first.next, /tripo__retrieve/);

  statuses[0] = "success";
  const later = await plugin.tool("retrieve", { id: TASK }, ctx);
  assert.equal(later.status, "success");
  assert.deepEqual(later.files, [`assets/tripo/${TASK}/model.glb`, `assets/tripo/${TASK}/preview.webp`]);
  assert.deepEqual(delivered, later.files);
});

test("retrieve of a finished task without files still reports Tripo's output", async () => {
  fakeTripo({ output: { riggable: true, rig_type: "biped" } });
  const { ctx } = fakeHost(root, game);
  const plugin = await activate(/** @type {any} */ ({}));
  await plugin.tool("generate", { operation: "animate_prerigcheck", id: TASK }, ctx);
  const again = await plugin.tool("retrieve", { id: TASK }, ctx);
  assert.deepEqual(again.output, { riggable: true, rig_type: "biped" });
});

test("a task id Tripo reports never names the download folder", async () => {
  fakeTripo({ taskId: "../../victim" });
  const { ctx } = fakeHost(root, game);
  const victim = path.join(root, "..", "victim");
  await mkdir(victim);
  await writeFile(path.join(victim, "keep.txt"), "keep");
  const plugin = await activate(/** @type {any} */ ({}));
  const result = await plugin.tool("generate", { operation: "text_to_model", prompt: "crate" }, ctx);
  await access(path.join(victim, "keep.txt"));
  assert.deepEqual(result.files, [`assets/tripo/${TASK}/model.glb`, `assets/tripo/${TASK}/preview.webp`]);
});

test("delivered downloads do not stay in plugin storage", async () => {
  fakeTripo();
  const { ctx } = fakeHost(root, game);
  const plugin = await activate(/** @type {any} */ ({}));
  await plugin.tool("generate", { operation: "text_to_model", prompt: "crate" }, ctx);
  await assert.rejects(access(path.join(root, "downloads", TASK)));
});

test("a download that redirects is refused instead of followed", async () => {
  // The fake answers as fetch would for a 302 to another host: an error, or the other host's body.
  let followed = false;
  fakeTripo({
    file: async (_url, init) => {
      if (init.redirect === "error") throw new TypeError("fetch failed: unexpected redirect");
      followed = true;
      return new Response(new Uint8Array([9]));
    },
  });
  const { ctx } = fakeHost(root, game);
  const plugin = await activate(/** @type {any} */ ({}));
  await assert.rejects(plugin.tool("generate", { operation: "text_to_model", prompt: "x" }, ctx), /redirect/);
  assert.equal(followed, false);
});

test("a download larger than the cap stops reading early", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let pulls = 0;
  fakeTripo({
    file: () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls > 300) controller.close();
            else controller.enqueue(chunk);
          },
        }),
      ),
  });
  const { ctx } = fakeHost(root, game);
  const plugin = await activate(/** @type {any} */ ({}));
  await assert.rejects(plugin.tool("generate", { operation: "text_to_model", prompt: "x" }, ctx), /larger than 100 MiB/);
  assert.ok(pulls < 110, `read ${pulls} MiB`);
});

test("stopping the turn ends a Tripo request that hangs", async () => {
  fakeTripo({
    poll: (init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason))),
  });
  const { ctx, stop } = fakeHost(root, game);
  const plugin = await activate(/** @type {any} */ ({}));
  const call = plugin.tool("retrieve", { id: TASK }, ctx);
  setImmediate(() => stop.abort(new Error("stopped")));
  await assert.rejects(call, /stopped/);
});
