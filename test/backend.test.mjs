import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
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
  const ctx = { project: "demo", directory: game, threadId: "t", callId: 1, signal: new AbortController().signal, host };
  return { ctx, jobs, calls, delivered, state };
}

/** Route fetch to canned Tripo answers; `statuses` is consumed one poll at a time. */
function fakeTripo({ statuses = ["success"], output } = {}) {
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", body: init.body, auth: init.headers?.Authorization });
    const json = (data) => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
    if (url.endsWith("/user/balance")) return json({ balance: 1200, frozen: 0 });
    if (url.endsWith("/upload/sts")) return json({ image_token: "img-token" });
    if (url.endsWith("/task") && init.method === "POST") return json({ task_id: TASK });
    if (url.includes(`/task/${TASK}`)) {
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      return json({
        task_id: TASK,
        type: "text_to_model",
        status,
        progress: status === "success" ? 100 : 50,
        output: status === "success" ? (output ?? { pbr_model: MODEL_URL, rendered_image: PREVIEW_URL }) : {},
      });
    }
    if (url.startsWith("https://tripo-data.")) return new Response(new Uint8Array([1, 2, 3]));
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
