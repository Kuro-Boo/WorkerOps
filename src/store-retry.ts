/**
 * store-retry — Cloudflare Workers の D1・KV・R2 への読み書きを、失敗を前提に取り直す小さな部品。
 * 依存は無い(Workers の型も持ち込まない)。Kuro License(MIT + 帰属表示・LICENSE.txt)。
 *
 * ## 使い方 — 束ねそのものを包む
 *
 * 読み書きの場所ごとに取り直しを書くと必ず漏れる。だから入口で env を包む。
 *   - Worker の入口: `export default retryingHandler({ fetch, scheduled })`
 *   - Durable Object・WorkerEntrypoint: `constructor(ctx, env) { super(ctx, withRetryingStores(env)); }`
 * 束ねは形で見分ける(D1 = prepare・batch・exec、R2 = head・createMultipartUpload、KV = getWithMetadata)。名前は問わない。
 *
 * ## 決まり
 *
 * 指数で間を広げ、ゆらぎを足し、回数で上限を切る。取り直しても通らなければ最後の誤りをそのまま投げる(握り潰さない)。
 *
 * ## 安全(二度書きと、外から起こせる増幅)
 *
 * - **二度書きをしない。** 書き込みが「通ったのに応答だけ失われた」とき、取り直すと同じ書き込みが 2 回走る。
 *   `UPDATE … SET n = n + 1` や追記では、それが数の狂いになる。だから D1 の書き込みは、
 *   **走っていないと分かる誤り**(混み合いで受け付けられなかった・係を起こせなかった)だけを取り直す。
 *   接続が切れた・時間切れのように、走ったか分からない誤りは、二度走っても同じになる文だけを取り直す
 *   (`INSERT … ON CONFLICT DO NOTHING`・`INSERT OR IGNORE`・`DELETE`、または呼ぶ側が `idempotent()` で印を付けた文)。
 *   読むだけの文(SELECT・WITH … SELECT・PRAGMA)は、どの一過性の誤りでも取り直す。
 * - KV と R2 の書き込みは鍵ごとの置き換え(同じ値を 2 度置いても同じ)なので取り直す。ただし R2 の `put` は、
 *   本文を読み直せるとき(文字列・ArrayBuffer・Blob)だけ。流れ(ReadableStream)は 1 度しか読めない。
 *   条件付きの `put`(onlyIf)は、走っていないと分かる誤りだけ(2 度目は条件で断られ、通ったのに失敗に見える)。
 * - **文の誤り・認証の断りは取り直さない**(何度送っても同じで、待つだけ遅くなる)。
 * - **増幅させない。** 外から起こせる失敗で取り直しを積ませないよう、isolate ごとに 1 分あたりの取り直しに上限を置く
 *   (超えたら取り直さずにすぐ投げる)。1 回の操作の待ちの合計にも上限がある。
 * - **値を記録しない。** 取り直しの記録は、場所の名前・操作・回数・誤りの種類だけ。誤りの文・SQL・鍵・値は出さない。
 */

export interface RetryOptions {
  /** 合計の試行回数(既定 4)。 */
  attempts?: number;
  /** 最初の待ち(ms・既定 500。0.5 → 1 → 2 秒と倍に伸ばす・仕様 core-shared-parts)。 */
  baseMs?: number;
  /** 1 回の待ちの上限(ms・既定 2000)。 */
  maxMs?: number;
  /** 取り直してよい誤りか(既定: 一過性の誤りすべて)。 */
  retryable?: (error: unknown) => boolean;
  /** 待ちの代わり(試験用)。 */
  sleep?: (ms: number) => Promise<void>;
}

/** 保管庫の包みの決まり。応答を待つ人のいない長く動く係は、間を広げてよい。 */
export interface StoreRetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  /** KV の書き込みの最初の待ち(既定 1000・KV は同じ鍵へ 1 秒に 1 回を超えると 429)。 */
  kvWriteBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** 長く動く係(Durable Object など・応答を待つ人がいない)の決まり。1 秒から広げ、8 秒で止める。 */
export const LONG_RUNNING_STORE_RETRY = { baseMs: 1000, maxMs: 8000 } as const;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ── 増幅の歯止め(isolate ごと)───────────────────────────────────────────────

/** 1 分あたりの取り直しの上限(isolate ごと)。超えたら取り直さない。 */
export const STORE_RETRY_BUDGET_PER_MINUTE = 120;
let budgetWindow = 0;
let budgetUsed = 0;

function takeBudget(now: number): boolean {
  const w = Math.floor(now / 60_000);
  if (w !== budgetWindow) { budgetWindow = w; budgetUsed = 0; }
  if (budgetUsed >= STORE_RETRY_BUDGET_PER_MINUTE) return false;
  budgetUsed++;
  return true;
}

/** 試験用: 歯止めの数を戻す。 */
export function resetStoreRetryBudget(): void { budgetWindow = 0; budgetUsed = 0; }

// ── 誤りの見分け ───────────────────────────────────────────────────────────

const text = (error: unknown): string => (error instanceof Error ? `${error.name} ${error.message}` : String(error));

/** 取り直しても同じ誤り(文の誤り・制約・認証)。 */
const PERMANENT = /constraint|syntax error|no such (table|column)|SQLITE_(CONSTRAINT|ERROR|MISMATCH|RANGE|TOOBIG)|unauthori[sz]ed|forbidden|\b40[0134]\b|not found|too (big|large)|exceeds? (the )?(max|limit)/i;

/** 一過性の誤り(KV・R2 の 429・5xx、D1 の接続・係の入れ替わり・混み合い・内部の誤り、時間切れ)。 */
const TRANSIENT = /\b(429|50[0-4])\b|too many requests|network connection lost|connection (reset|refused|closed|lost)|internal error|overloaded|reset because|object to be reset|timed? ?out|exceeded timeout|fetch failed|temporar(y|ily)|unavailable|\((10001|10043|10058)\)|reduce your (concurrent )?request rate|TimeoutError/i;

/** 走っていないと分かる誤り(受け付ける前に断られた)。書き込みでも取り直してよい。 */
const UNEXECUTED = /\b429\b|too many requests|overloaded|requests? queued|queue(d)? for too long|transient issue on remote node|while starting up|reduce your (concurrent )?request rate|\(10058\)/i;

/** 一過性の誤りか(取り直してよいか)。 */
export function isTransientStoreError(error: unknown): boolean {
  const t = text(error);
  if (UNEXECUTED.test(t)) return true;
  if (PERMANENT.test(t)) return false;
  return TRANSIENT.test(t);
}

/** 受け付ける前に断られた誤りか(書き込みが走っていないと言えるか)。 */
export function isUnexecutedStoreError(error: unknown): boolean {
  return UNEXECUTED.test(text(error));
}

/** 記録に載せる誤りの種類(文そのものは載せない)。 */
function errorKind(error: unknown): string {
  const t = text(error);
  if (UNEXECUTED.test(t)) return 'rejected';
  if (/timed? ?out|exceeded timeout|TimeoutError/i.test(t)) return 'timeout';
  if (/connection|network|fetch failed/i.test(t)) return 'connection';
  if (/\b50[0-4]\b|internal error|unavailable/i.test(t)) return 'server';
  return 'other';
}

// ── 取り直しの本体 ─────────────────────────────────────────────────────────

/**
 * 操作を取り直す。`retryable` が偽を返す誤り・回数を使い切った誤りは、そのまま投げる。
 * label は記録に出る場所の名前(`DB.first` など)。値や SQL を入れない。
 */
export async function withStoreRetry<T>(label: string, op: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, Math.min(8, options.attempts ?? 4));
  const base = Math.max(0, options.baseMs ?? 500);
  const max = Math.max(base, options.maxMs ?? 2000);
  const sleep = options.sleep ?? wait;
  const retryable = options.retryable ?? isTransientStoreError;
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await op();
    } catch (error) {
      last = error;
      if (i >= attempts || !retryable(error) || !takeBudget(Date.now())) break;
      const delay = Math.min(max, base * 2 ** (i - 1));
      console.warn(`store_retry ${label.slice(0, 60)} attempt=${i} kind=${errorKind(error)}`);
      await sleep(delay + Math.floor(Math.random() * Math.min(500, delay / 2 + 1)));
    }
  }
  throw last;
}

// ── D1 ────────────────────────────────────────────────────────────────────

/** 使う所だけの D1 の形(Workers の型をライブラリーに持ち込まない)。 */
interface D1Stmt {
  bind(...args: unknown[]): D1Stmt;
  first(...args: unknown[]): Promise<unknown>;
  all(...args: unknown[]): Promise<unknown>;
  run(...args: unknown[]): Promise<unknown>;
  raw(...args: unknown[]): Promise<unknown>;
}
interface D1Like {
  prepare(sql: string): D1Stmt;
  batch(statements: D1Stmt[]): Promise<unknown>;
  exec(sql: string): Promise<unknown>;
}

/** 包んだ文 → 元の文(batch へは元の文を渡す。包みのままでは D1 が受け付けない)と、二度走っても同じか。 */
const rawStatement = new WeakMap<object, { raw: D1Stmt; sql: string; idempotent: boolean }>();

/** 先頭の注釈を除いた最初の語。 */
function leading(sql: string): string {
  return sql.replace(/^(\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, '').slice(0, 4000);
}

/** 読むだけの文か。WITH は、後ろに書く語が無いときだけ読むだけとみなす。 */
export function isReadOnlySql(sql: string): boolean {
  const s = leading(sql);
  if (/^(select|pragma|explain)\b/i.test(s)) return true;
  if (/^with\b/i.test(s)) return !/\b(insert|update|delete|replace|upsert)\b/i.test(s);
  return false;
}

/** 二度走っても同じになる書き込みか(形で言えるものだけ)。 */
export function isIdempotentSql(sql: string): boolean {
  const s = leading(sql);
  if (/^delete\b/i.test(s)) return true;
  if (/^insert\s+or\s+ignore\b/i.test(s)) return true;
  if (/^insert\b/i.test(s) && /\bon\s+conflict\b[^;]*\bdo\s+nothing\b/i.test(s)) return true;
  return false;
}

/**
 * 二度走っても同じになると呼ぶ側が請け合う文に印を付ける(`UPDATE … SET state = ?1 WHERE id = ?2` など)。
 * 数を足す・追記する文に付けない。
 */
export function idempotent<S>(stmt: S): S {
  const meta = rawStatement.get(stmt as object);
  if (meta) meta.idempotent = true;
  return stmt;
}

function d1Retryable(readOnly: boolean, idem: boolean): (e: unknown) => boolean {
  return readOnly || idem ? isTransientStoreError : isUnexecutedStoreError;
}

function retryingStatement(stmt: D1Stmt, sql: string, name: string, o: StoreRetryOptions, idem: boolean): D1Stmt {
  const readOnly = isReadOnlySql(sql);
  const meta = { raw: stmt, sql, idempotent: idem || isIdempotentSql(sql) };
  const proxy: D1Stmt = new Proxy(stmt, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop === 'bind') {
        return (...args: unknown[]) => retryingStatement((value as (...a: unknown[]) => D1Stmt).apply(target, args), sql, name, o, meta.idempotent);
      }
      if (prop === 'first' || prop === 'all' || prop === 'run' || prop === 'raw') {
        return (...args: unknown[]) => withStoreRetry(`${name}.${prop}`,
          () => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args),
          { ...o, retryable: d1Retryable(readOnly, meta.idempotent) });
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
  rawStatement.set(proxy, meta);
  return proxy;
}

/**
 * D1 の束ねを、問い合わせを取り直す包みに替える(prepare の文・batch・exec)。
 * batch は 1 つのトランザクション(半端には書かれない)。全部が読むだけか二度走っても同じなら一過性の誤りで、
 * そうでなければ受け付けられなかった誤りだけで取り直す。exec(移行の文)は受け付けられなかった誤りだけ。
 */
export function retryingD1<D>(db: D, name: string, o: StoreRetryOptions = {}): D {
  const target = db as unknown as D1Like;
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop === 'prepare') return (sql: string) => retryingStatement(t.prepare(sql), String(sql), name, o, false);
      if (prop === 'batch') {
        return (statements: D1Stmt[]) => {
          const metas = statements.map((s) => rawStatement.get(s));
          const safe = metas.every((m) => m && (isReadOnlySql(m.sql) || m.idempotent));
          return withStoreRetry(`${name}.batch`, () => t.batch(statements.map((s, i) => metas[i]?.raw ?? s)),
            { ...o, retryable: safe ? isTransientStoreError : isUnexecutedStoreError });
        };
      }
      if (prop === 'exec') return (sql: string) => withStoreRetry(`${name}.exec`, () => t.exec(sql), { ...o, retryable: isUnexecutedStoreError });
      return (value as (...a: unknown[]) => unknown).bind(t);
    },
  }) as unknown as D;
}

// ── KV ────────────────────────────────────────────────────────────────────

const KV_READS = new Set(['get', 'getWithMetadata', 'list']);
const KV_WRITES = new Set(['put', 'delete']);

/** KV の束ねを、読み書きを取り直す包みに替える。書き込みは KV の 1 秒 1 回に合わせて間を広げる。 */
export function retryingKV<K>(kv: K, name: string, o: StoreRetryOptions = {}): K {
  const target = kv as unknown as Record<string, unknown>;
  const writeOpts: RetryOptions = { ...o, baseMs: o.kvWriteBaseMs ?? Math.max(1000, o.baseMs ?? 0), maxMs: Math.max(o.maxMs ?? 4000, 4000) };
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      if (!KV_READS.has(prop) && !KV_WRITES.has(prop)) return (value as (...a: unknown[]) => unknown).bind(t);
      return (...args: unknown[]) => withStoreRetry(`${name}.${prop}`,
        () => (value as (...a: unknown[]) => Promise<unknown>).apply(t, args), KV_WRITES.has(prop) ? writeOpts : o);
    },
  }) as unknown as K;
}

// ── R2 ────────────────────────────────────────────────────────────────────

/** 読み直せる本文か(流れは 1 度しか読めない)。 */
function replayable(body: unknown): boolean {
  if (body === null || body === undefined || typeof body === 'string') return true;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  return typeof Blob !== 'undefined' && body instanceof Blob;
}

/** R2 の束ねを、読み書きを取り直す包みに替える(head・get・list・put・delete)。分割の書き込みは包まない。 */
export function retryingR2<B>(bucket: B, name: string, o: StoreRetryOptions = {}): B {
  const target = bucket as unknown as Record<string, unknown>;
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      const call = (args: unknown[]) => (value as (...a: unknown[]) => Promise<unknown>).apply(t, args);
      if (prop === 'head' || prop === 'get' || prop === 'list' || prop === 'delete') {
        return (...args: unknown[]) => withStoreRetry(`${name}.${prop}`, () => call(args), o);
      }
      if (prop === 'put') {
        return (...args: unknown[]) => {
          if (!replayable(args[1])) return call(args);
          const conditional = Boolean((args[2] as { onlyIf?: unknown } | undefined)?.onlyIf);
          return withStoreRetry(`${name}.put`, () => call(args), { ...o, retryable: conditional ? isUnexecutedStoreError : isTransientStoreError });
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(t);
    },
  }) as unknown as B;
}

// ── env の包み ──────────────────────────────────────────────────────────────

type Kind = 'd1' | 'kv' | 'r2';

/** 束ねの種類を形で見分ける。見分けられないもの(秘密・サービス・Durable Object など)は null。 */
export function storeKind(value: unknown): Kind | null {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
  const v = value as Record<string, unknown>;
  const fn = (k: string) => typeof v[k] === 'function';
  // RPC の束縛(Service Binding・Durable Object の stub)は、どんな名前を引いても関数(遠くの口)を返すので、
  // 形だけ見ると D1 にも KV にも見える。包むと、呼んだ口が `<口>.bind` という無い口への呼び出しに化けて
  // 応答が返らない。在りえない名前が関数なら RPC。
  if (fn('__store_retry_probe__')) return null;
  if (fn('prepare') && fn('batch') && fn('exec')) return 'd1';
  if (fn('head') && fn('put') && fn('get') && fn('createMultipartUpload')) return 'r2';
  if (fn('getWithMetadata') && fn('put') && fn('get') && fn('list') && fn('delete')) return 'kv';
  return null;
}

const wrappedEnvs = new WeakMap<object, unknown>();
const wrappedSet = new WeakSet<object>();

/**
 * env の D1・KV・R2 をすべて、取り直す包みに替える。名前を並べない(足した束ねが漏れない)。
 * env は写さずに、読むときだけ差し替える({...env} で写すと、列挙されない束ねが落ちることがある)。
 * 同じ env を何度渡しても同じ包みが返る。包んだものを渡せばそのまま返る。
 */
export function withRetryingStores<E>(env: E, o: StoreRetryOptions = {}): E {
  if (!env || typeof env !== 'object') return env;
  const raw = env as unknown as object;
  if (wrappedSet.has(raw)) return env;
  const done = wrappedEnvs.get(raw);
  if (done) return done as E;
  const cache = new Map<PropertyKey, unknown>();
  const out = new Proxy(raw, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string') return value;
      const hit = cache.get(prop);
      if (hit !== undefined && cache.get(`${prop}\u0000raw`) === value) return hit;
      const kind = storeKind(value);
      if (!kind) return value;
      const name = prop.slice(0, 40);
      const wrapped = kind === 'd1' ? retryingD1(value, name, o) : kind === 'kv' ? retryingKV(value, name, o) : retryingR2(value, name, o);
      cache.set(prop, wrapped);
      cache.set(`${prop}\u0000raw`, value);
      return wrapped;
    },
  });
  wrappedEnvs.set(raw, out);
  wrappedSet.add(out);
  return out as E;
}

const ENTRY_METHODS = ['fetch', 'scheduled', 'queue', 'email', 'tail', 'trace'] as const;

/**
 * Worker の入口(fetch・scheduled・queue・email・tail)を包み、env の保管庫を取り直す包みに替えて渡す。
 * 入口に無いものはそのまま残す。
 */
export function retryingHandler<H extends object>(handler: H, o: StoreRetryOptions = {}): H {
  const out: Record<string, unknown> = { ...(handler as Record<string, unknown>) };
  for (const m of ENTRY_METHODS) {
    const fn = (handler as Record<string, unknown>)[m];
    if (typeof fn !== 'function') continue;
    out[m] = function (this: unknown, first: unknown, env: unknown, ...rest: unknown[]) {
      return (fn as (...a: unknown[]) => unknown).call(this ?? handler, first, withRetryingStores(env, o), ...rest);
    };
  }
  return out as H;
}
