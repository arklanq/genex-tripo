import path from "node:path";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";

/** Tripo's OpenAPI v2 root. */
const API = "https://api.tripo3d.ai/v2/openapi";
/** Hosts a download may come from; Tripo serves results from its own domains. */
const DOWNLOAD_HOSTS = [".tripo3d.ai", ".tripo3d.com"];
/** How long one tool call waits for a task; Studio ends a plugin call after 190 s. */
const WAIT_MS = 150_000;
const POLL_MS = 3_000;
/** The largest single file the plugin downloads or uploads. */
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** How many recent tasks the job index keeps. */
const INDEX_SIZE = 50;
const INDEX_ID = "index";
/** How much of the key's end the panel shows, so the user can tell keys apart. */
const KEY_HINT_CHARS = 4;
/** Tripo task ids are UUIDs, which is also the job id shape Studio's asset delivery accepts. */
const TASK_ID = /^[a-f0-9-]{36}$/;

const Status = { Queued: "queued", Running: "running", Success: "success" };
const PENDING = new Set([Status.Queued, Status.Running]);

/** Operations that make a new model from a prompt or a picture. */
const SOURCE_OPERATIONS = new Set(["text_to_model", "image_to_model"]);
/** Operations that work on an earlier task's model, named by `original_model_task_id`. */
const DERIVED_OPERATIONS = new Set([
  "texture_model",
  "animate_prerigcheck",
  "animate_rig",
  "animate_retarget",
  "stylize_model",
  "convert_model",
]);
/** Fields the plugin sets itself; an agent's options may not override them. */
const RESERVED_OPTIONS = ["type", "file", "files", "original_model_task_id", "imageUrl"];
/** Downloadable output fields, best first; the first one present becomes `model`. */
const MODEL_OUTPUTS = ["pbr_model", "model", "base_model"];
const IMAGE_TYPES = { ".png": "png", ".jpg": "jpg", ".jpeg": "jpg", ".webp": "webp" };

const MESSAGE = {
  Locked: "The Tripo key is locked or not set. Open Plugins → Tripo and press Connect.",
  ProjectRequired: "Open a game first.",
  BadKey: "A Tripo API key starts with tsk_.",
  BadTaskId: "A Tripo task id is a UUID such as 1ec04ced-4b87-44f6-a296-beee80777941.",
  UnknownOperation: (op) =>
    `Unknown operation ${op}. Use ${[...SOURCE_OPERATIONS, ...DERIVED_OPERATIONS].join(", ")}.`,
  PromptRequired: "text_to_model needs a prompt.",
  ImageRequired: "image_to_model needs image (a project-relative file) or options.imageUrl.",
  IdRequired: (op) => `${op} needs id, the Tripo task id of the model to work on.`,
  BadImagePath: "image must be a project-relative path outside dot folders and node_modules.",
  BadImageType: "image must be a .png, .jpg, .jpeg or .webp file.",
  ImageTooLarge: "image is larger than Tripo's 10 MB limit.",
  BadOptions: "options must be a JSON object.",
  DownloadHost: (host) => `Refusing to download from ${host}: not a Tripo host.`,
  DownloadTooLarge: "A Tripo result is larger than 100 MiB.",
  UnknownAction: "Unknown Tripo action.",
};

/**
 * Read the unlocked Tripo key from the host's memory lease.
 * @param {import('./plugin-sdk/index.d.ts').PluginContext} ctx
 */
async function sessionKey(ctx) {
  const key = await ctx.host("credentials.session");
  if (!key) throw new Error(MESSAGE.Locked);
  return key;
}

/**
 * Call the Tripo API and return its `data`, or throw Tripo's own message.
 * @param {string} key
 * @param {string} route
 * @param {RequestInit} [init]
 */
async function tripo(key, route, init = {}) {
  const response = await fetch(`${API}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, ...init.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.code !== 0) {
    const detail = [body?.message, body?.suggestion].filter(Boolean).join(" ");
    throw new Error(`Tripo ${response.status}${body?.code ? ` (code ${body.code})` : ""}: ${detail || response.statusText}`);
  }
  return body.data;
}

/** Wait `ms`, ending early when the turn is stopped. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * Normalize `options`, which may arrive as an object or as legacy JSON text.
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function parseOptions(value) {
  if (value === undefined || value === null || value === "") return {};
  const options = typeof value === "string" ? JSON.parse(value) : value;
  if (typeof options !== "object" || Array.isArray(options)) throw new Error(MESSAGE.BadOptions);
  return /** @type {Record<string, unknown>} */ (options);
}

/**
 * Read a project image for upload, refusing anything outside the bound game.
 * @param {string} directory
 * @param {string} relative
 */
async function readProjectImage(directory, relative) {
  const parts = relative.split(/[\\/]/);
  if (path.isAbsolute(relative) || parts.some((p) => p === ".." || p.startsWith(".") || p === "node_modules"))
    throw new Error(MESSAGE.BadImagePath);
  const type = IMAGE_TYPES[/** @type {keyof typeof IMAGE_TYPES} */ (path.extname(relative).toLowerCase())];
  if (!type) throw new Error(MESSAGE.BadImageType);
  const base = await realpath(directory);
  const file = await realpath(path.join(base, relative));
  if (!file.startsWith(base + path.sep)) throw new Error(MESSAGE.BadImagePath);
  const bytes = await readFile(file);
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(MESSAGE.ImageTooLarge);
  return { bytes, type, name: path.basename(file) };
}

/**
 * Upload a project image and return the `file` field image_to_model expects.
 * @param {string} key
 * @param {string} directory
 * @param {string} relative
 */
async function uploadImage(key, directory, relative) {
  const image = await readProjectImage(directory, relative);
  const form = new FormData();
  form.append("file", new Blob([image.bytes]), image.name);
  const data = await tripo(key, "/upload/sts", { method: "POST", body: form });
  return { type: image.type, file_token: data.image_token };
}

/**
 * Build the Tripo task body for one tool call.
 * @param {string} key
 * @param {string} directory
 * @param {Record<string, unknown>} args
 */
async function taskBody(key, directory, args) {
  const operation = String(args.operation ?? "");
  const options = parseOptions(args.options);
  const body = Object.fromEntries(Object.entries(options).filter(([k]) => !RESERVED_OPTIONS.includes(k)));
  body.type = operation;
  if (operation === "text_to_model") {
    if (!args.prompt) throw new Error(MESSAGE.PromptRequired);
    body.prompt = String(args.prompt);
  } else if (operation === "image_to_model") {
    if (args.image) body.file = await uploadImage(key, directory, String(args.image));
    else if (typeof options.imageUrl === "string") body.file = { type: "jpg", url: options.imageUrl };
    else throw new Error(MESSAGE.ImageRequired);
    if (args.prompt) body.prompt = String(args.prompt);
  } else if (DERIVED_OPERATIONS.has(operation)) {
    if (!args.id) throw new Error(MESSAGE.IdRequired(operation));
    body.original_model_task_id = taskId(args.id);
  } else {
    throw new Error(MESSAGE.UnknownOperation(operation));
  }
  return body;
}

/** @param {unknown} value */
function taskId(value) {
  const id = String(value ?? "").toLowerCase();
  if (!TASK_ID.test(id)) throw new Error(MESSAGE.BadTaskId);
  return id;
}

/**
 * Download one Tripo result URL into `dir` as `<name><ext>`.
 * @param {string} url
 * @param {string} dir
 * @param {string} name
 */
async function download(url, dir, name) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !DOWNLOAD_HOSTS.some((h) => parsed.hostname.endsWith(h)))
    throw new Error(MESSAGE.DownloadHost(parsed.hostname));
  const response = await fetch(parsed);
  if (!response.ok) throw new Error(`Tripo download ${response.status}: ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error(MESSAGE.DownloadTooLarge);
  const file = `${name}${path.extname(parsed.pathname).toLowerCase() || ".bin"}`;
  await writeFile(path.join(dir, file), bytes);
}

/** @param {unknown} value */
const urlOf = (value) =>
  typeof value === "string" ? value : typeof value === "object" && value ? /** @type {any} */ (value).url : undefined;

/**
 * Download a finished task's model and preview, then copy them into the game.
 * @param {import('./plugin-sdk/index.d.ts').PluginContext} ctx
 * @param {any} task
 */
async function deliver(ctx, task) {
  const output = task.output ?? {};
  const model = MODEL_OUTPUTS.map((field) => urlOf(output[field])).find(Boolean);
  const preview = urlOf(output.rendered_image);
  if (!model && !preview) return [];
  const dir = path.join(String(await ctx.host("storage.root")), "downloads", task.task_id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  if (model) await download(model, dir, "model");
  if (preview) await download(preview, dir, "preview");
  return ctx.host("assets.deliver", { output: dir, jobId: task.task_id });
}

/**
 * Poll a task until it ends or the wait runs out, then deliver its files once.
 * @param {import('./plugin-sdk/index.d.ts').PluginContext} ctx
 * @param {string} key
 * @param {string} id
 */
async function settle(ctx, key, id) {
  const deadline = Date.now() + WAIT_MS;
  let task = await tripo(key, `/task/${id}`);
  while (PENDING.has(task.status) && Date.now() < deadline) {
    await sleep(POLL_MS, ctx.signal);
    task = await tripo(key, `/task/${id}`);
  }
  const record = /** @type {any} */ ((await ctx.host("jobs.read", { id })) ?? { taskId: id });
  // Only a record that reached success holds delivered files; a pending one holds an empty list.
  const delivered = record.status === Status.Success ? record.files : undefined;
  const result = {
    taskId: id,
    operation: task.type,
    status: task.status,
    progress: task.progress,
    consumedCredit: task.consumed_credit,
    files: delivered ?? [],
  };
  if (task.status === Status.Success && !delivered) result.files = await deliver(ctx, task);
  // Outputs without files (a pre-rig check) are reported as Tripo returned them.
  if (task.status === Status.Success && result.files.length === 0) result.output = task.output;
  await ctx.host("jobs.write", { id, value: { ...record, status: task.status, files: result.files } });
  if (PENDING.has(task.status))
    return { ...result, next: `Still ${task.status}. Call tripo__retrieve with id ${id}; do not generate again.` };
  return result;
}

/** Serialize index writes so concurrent tasks do not drop each other. */
let indexWrite = Promise.resolve();

/**
 * Remember a submitted task, newest first.
 * @param {import('./plugin-sdk/index.d.ts').PluginContext} ctx
 * @param {Record<string, unknown>} entry
 */
function remember(ctx, entry) {
  const next = indexWrite.then(async () => {
    const index = /** @type {any[]} */ ((await ctx.host("jobs.read", { id: INDEX_ID })) ?? []);
    await ctx.host("jobs.write", { id: INDEX_ID, value: [entry, ...index].slice(0, INDEX_SIZE) });
  });
  indexWrite = next.catch(() => {});
  return next;
}

/**
 * The account and recent tasks, for the agent's status tool and the panel's status action.
 * @param {import('./plugin-sdk/index.d.ts').PluginContext} ctx
 */
async function status(ctx) {
  const key = await ctx.host("credentials.session");
  const index = /** @type {any[]} */ ((await ctx.host("jobs.read", { id: INDEX_ID })) ?? []);
  const jobs = index.filter((job) => !ctx.project || job.project === ctx.project).slice(0, 10);
  if (!key) return { connected: false, message: MESSAGE.Locked, jobs };
  const keyHint = key.slice(-KEY_HINT_CHARS);
  try {
    const wallet = await tripo(key, "/user/balance");
    return { connected: true, keyHint, balance: wallet.balance, frozen: wallet.frozen, jobs };
  } catch (error) {
    return { connected: true, keyHint, error: String(error instanceof Error ? error.message : error), jobs };
  }
}

/** @type {Record<string, (args: Record<string, any>, ctx: import('./plugin-sdk/index.d.ts').PluginContext) => Promise<unknown>>} */
const ACTIONS = {
  status: (_args, ctx) => status(ctx),
  async unlock(_args, ctx) {
    return { connected: !!(await ctx.host("credentials.read")) };
  },
  // Without a key, Connect reuses the saved one; the panel sends a new key as `token`.
  async connect(args, ctx) {
    if (typeof args.token !== "string" || !args.token.trim()) {
      const saved = await ctx.host("credentials.read");
      return saved ? { connected: true } : { connected: false, needsKey: true };
    }
    const token = args.token.trim();
    if (!token.startsWith("tsk_")) throw new Error(MESSAGE.BadKey);
    const wallet = await tripo(token, "/user/balance");
    await ctx.host("credentials.write", { token });
    return { connected: true, balance: wallet.balance, frozen: wallet.frozen };
  },
  async disconnect(_args, ctx) {
    await ctx.host("credentials.clear");
    return { connected: false };
  },
};

/** @type {import('./plugin-sdk/index.d.ts').Activate} */
export const activate = async () => ({
  async tool(name, args, ctx) {
    if (name === "status") return status(ctx);
    if (!ctx.project || !ctx.directory) throw new Error(MESSAGE.ProjectRequired);
    const key = await sessionKey(ctx);
    if (name === "retrieve") return settle(ctx, key, taskId(args.id));
    const body = await taskBody(key, ctx.directory, args);
    const { task_id: id } = await tripo(key, "/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // Persist the remote reference before waiting, so a lost call can be retrieved instead of repeated.
    const entry = {
      taskId: id,
      operation: body.type,
      prompt: body.prompt,
      project: ctx.project,
      createdAt: new Date().toISOString(),
    };
    await ctx.host("jobs.write", { id, value: entry });
    await remember(ctx, entry);
    return settle(ctx, key, id);
  },
  async action(name, args, ctx) {
    const run = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : undefined;
    if (!run) throw new Error(MESSAGE.UnknownAction);
    return run(args, ctx);
  },
});
