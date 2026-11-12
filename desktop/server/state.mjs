import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

const brandingVersion = 2;
const tagNameAliases = new Set(["阿序", "阿叙", "阿敘", "观序", "觀序", "tag"]);
const legacyConversationTitle = "此前与 Tag 的对话";
export const DEFAULT_CONVERSATION_ID = "conversation-default";
export const LEGACY_CONVERSATION_ID = "conversation-legacy";

export function currentCompanionName(name) {
  return typeof name === "string" && tagNameAliases.has(name.normalize("NFKC").trim().toLowerCase()) ? "Tag" : name;
}

export function currentConversationTitle(conversation) {
  if (conversation.titleSource !== "legacy") return conversation.title;
  const name = /^此前[与與]\s*(\S+)\s*的[对對][话話]$/u.exec(conversation.title)?.[1];
  return currentCompanionName(name) === "Tag" ? legacyConversationTitle : conversation.title;
}

/** Add conversation ownership without changing existing record IDs or content. */
export function migrateConversations(state) {
  const stamp = new Date().toISOString();
  if (state.conversations === undefined) state.conversations = [];
  if (!Array.isArray(state.conversations) || state.conversations.some(item => !item || typeof item.id !== "string" || !item.id || typeof item.title !== "string") || new Set(state.conversations.map(item => item.id)).size !== state.conversations.length) throw new Error("本地对话格式不受支持；原文件已保留。");
  const known = new Map(state.conversations.map(item => [item.id, item]));
  const entries = [...state.messages, ...state.jobs];
  const times = entries.map(item => item.createdAt).filter(value => typeof value === "string" && Number.isFinite(Date.parse(value))).sort();
  const ensure = (conversationId, title, titleSource = "legacy") => {
    if (!known.has(conversationId)) {
      const conversation = { id: conversationId, title, titleSource, createdAt: times[0] || stamp, updatedAt: times.at(-1) || stamp };
      state.conversations.push(conversation); known.set(conversationId, conversation);
    }
    return conversationId;
  };
  for (const entry of entries) if (typeof entry.conversationId === "string" && entry.conversationId) ensure(entry.conversationId, legacyConversationTitle);
  for (const entry of state.messages) if (!entry.conversationId) entry.conversationId = ensure(LEGACY_CONVERSATION_ID, legacyConversationTitle);
  for (const job of state.jobs) if (!job.conversationId) {
    const source = state.messages.find(item => item.id === job.messageId);
    job.conversationId = source?.conversationId || ensure(LEGACY_CONVERSATION_ID, legacyConversationTitle);
  }
  if (!state.conversations.length) ensure(DEFAULT_CONVERSATION_ID, "新的对话", "automatic");
  if (!known.has(state.activeConversationId)) state.activeConversationId = known.has(LEGACY_CONVERSATION_ID) ? LEGACY_CONVERSATION_ID : state.conversations[0].id;
  return state;
}

export function initialState() {
  return {
    version: 1,
    brandingVersion,
    profile: { name: "Tag", personality: "安静敏锐", preferences: "" },
    collections: [], exhibitions: [], messages: [], jobs: [],
  };
}

export async function openState(directory, { onChange } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = path.join(directory, "state.json");
  let state;
  try {
    state = JSON.parse(await readFile(file, "utf8"));
    if (state.version !== 1 || !state.profile || ["collections", "exhibitions", "messages", "jobs"].some((key) => !Array.isArray(state[key]))) {
      throw new Error("本地资料格式不受支持；原文件已保留，请先备份后检查。");
    }
    // Only pre-migration copies of the first default are known to use it as a
    // product name. Later user-selected nicknames are kept in the stored data.
    if (!Number.isInteger(state.brandingVersion) || state.brandingVersion < brandingVersion) {
      const previousVersion = Number.isInteger(state.brandingVersion) ? state.brandingVersion : 0;
      state.profile.name = previousVersion < 1 && state.profile.name === "拾" ? "Tag" : currentCompanionName(state.profile.name);
      if (Array.isArray(state.conversations)) for (const conversation of state.conversations) {
        if (conversation?.titleSource === "legacy") conversation.title = currentConversationTitle(conversation);
      }
      state.brandingVersion = brandingVersion;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = initialState();
  }
  let tail = Promise.resolve();
  async function save(next) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(temporary, file);
    state = next;
    try { onChange?.(); } catch {}
    return structuredClone(state);
  }
  const store = {
    directory,
    read: () => structuredClone(state),
    update(mutator) {
      const operation = tail.then(async () => {
        const next = structuredClone(state);
        await mutator(next);
        return save(next);
      });
      tail = operation.catch(() => {});
      return operation;
    },
    flush: () => tail,
  };
  await store.update(() => {});
  return store;
}

export async function ensureSigningSecret(directory) {
  if (process.env.FORME_SESSION_SECRET?.length >= 32) return;
  const file = path.join(directory, "signing-secret");
  let secret;
  try { secret = await readFile(file, "utf8"); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    secret = randomBytes(48).toString("base64url");
    try { await writeFile(file, secret, { mode: 0o600, flag: "wx" }); }
    catch (writeError) {
      if (writeError.code !== "EEXIST") throw writeError;
      secret = await readFile(file, "utf8");
    }
  }
  if (secret.trim().length < 32) throw new Error("本地签名密钥损坏；请保留原资料并检查配置。");
  await chmod(file, 0o600);
  process.env.FORME_SESSION_SECRET = secret.trim();
}
