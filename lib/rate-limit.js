// @ts-check
// 速率限制（可用性第一層，William 定 2026-07-28：「應該要防就要防」）。**只在 HOSTED 生效**。
//
// 為什麼 LOCAL 不做：你的 Mac 只聽 127.0.0.1、只有你一個人在用，限制自己毫無意義，
// 反而會在「一次匯入十二個月帳單」這種正當的密集操作時擋自己（AGENTS.md 的雙模式契約：LOCAL 零改動）。
//
// **這一層防得到什麼、防不到什麼（誠實劃界，別把它當 DDoS 防護）**：
//   ✅ 防得到：單一來源反覆猛打造成的**行程資源耗盡**——連續猜密碼、反覆丟大 PDF 把 CPU 佔住。
//   ❌ 防不到：真正的大流量 DDoS。那種攻擊在我們的程式跑起來之前就把頻寬與連線塞爆了，
//      只有「在服務前面再擺一層」（Cloudflare）才擋得住。見 docs/多人上線-施工計畫.md 第十節。
//
// 兩個實作決定：
// ① **記憶體內、零依賴**：這個專案的紀律是不隨便加相依。資料量極小（一個 Map，過期自動清），
//    重啟歸零也無所謂——速率限制本來就是短窗口的東西。
//    ⚠️ **多實例部署時每個實例各算各的**（等於上限變成 N 倍）。Render 目前單實例；
//    要開多實例前必須改成共用儲存（Redis／Postgres），這條寫進 AGENTS.md 的同步點。
// ② **固定窗口而不是滑動窗口**：夠用、便宜、看得懂。代價是窗口交界處理論上可以打到 2 倍，
//    對「防資源耗盡」這個目的無所謂（我們要擋的是持續猛打，不是精準計數）。

/** 一顆計數器最多追蹤幾個鍵（超過就開始淘汰）。 */
export const DEFAULT_MAX_KEYS = 10_000;

/**
 * 造一個計數器。**時鐘可注入**——考題不必真的等時間過去（等時間的考題又慢又不穩）。
 * @param {{windowMs: number, max: number, maxKeys?: number, now?: () => number}} opts
 */
export function createLimiter({ windowMs, max, maxKeys = DEFAULT_MAX_KEYS, now = () => Date.now() }) {
  /** key → { count, resetAt } @type {Map<string, {count: number, resetAt: number}>} */
  const hits = new Map();
  let lastSweep = 0;

  /** 清掉過期的鍵（不掃就會隨著不同 IP 無限長大＝把「防資源耗盡」自己變成資源耗盡）。 @param {number} t */
  function sweep(t) {
    if (t - lastSweep < windowMs) return;   // 每個窗口最多掃一次
    lastSweep = t;
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
  }

  /**
   * 表滿了就淘汰**最早插入的那一個**。
   *
   * 為什麼還需要這道（`sweep` 不夠）：sweep 每個窗口最多跑一次，攻擊者高速換 IP 時，
   * 兩次 sweep 之間可以塞進幾百萬個鍵——「防資源耗盡」自己就成了資源耗盡的來源。
   *
   * 為什麼淘汰「最早插入的」是對的：`hit()` 續約時**先 delete 再 set**，所以 Map 的
   * 插入順序＝到期順序，隊首就是最接近到期（多半已經過期）的那一個。O(1)，
   * 不必在被猛打的時候掃全表。
   */
  function evictOldest() {
    if (hits.size < maxKeys) return;
    const oldest = hits.keys().next().value;
    if (oldest !== undefined) hits.delete(oldest);
  }

  return {
    /**
     * 記一次並回報可不可以放行。
     * @param {string} key @returns {{allowed: boolean, remaining: number, retryAfterSec: number}}
     */
    hit(key) {
      const t = now();
      sweep(t);
      const cur = hits.get(key);
      if (!cur || cur.resetAt <= t) {
        // ⚠️ 續約要「先 delete 再 set」：`Map.set` 對**既有 key 不改插入位置**。不 delete 的話，
        //    「已經過期、還沒被 sweep 掃到、又被續約」的鍵會帶著最新的 resetAt 留在隊首，
        //    「插入順序＝到期順序」就不成立，淘汰會挑到最晚到期的那一個（考題釘死這條）。
        //    而且只有**真的新增鍵**才需要淘汰——既有鍵續約不會讓表變大。
        if (cur) hits.delete(key); else evictOldest();
        hits.set(key, { count: 1, resetAt: t + windowMs });
        return { allowed: true, remaining: max - 1, retryAfterSec: 0 };
      }
      cur.count++;
      const allowed = cur.count <= max;
      return {
        allowed,
        remaining: Math.max(0, max - cur.count),
        retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((cur.resetAt - t) / 1000)),
      };
    },
    /** 目前追蹤中的鍵數（考題用：驗過期真的被清掉）。 */
    size() { return hits.size; },
    /** 清空（考題用）。 */
    reset() { hits.clear(); lastSweep = 0; },
  };
}

/**
 * 包成 Express 中介層。
 * ⚠️ **超過上限時直接回 429，不 throw**：這條路要盡量便宜——丟例外會走一趟全域錯誤中介、
 * 產生堆疊物件，正好在「被猛打」的時候增加成本。
 * 回應帶 `Retry-After`（秒），前端與 curl 都看得懂。
 * @param {{windowMs: number, max: number, maxKeys?: number, keyOf: (req: any) => string|null, message: string, now?: () => number}} opts
 * @returns {import('express').RequestHandler}
 */
export function rateLimit({ windowMs, max, maxKeys, keyOf, message, now }) {
  const limiter = createLimiter({ windowMs, max, maxKeys, now });
  const mw = /** @type {import('express').RequestHandler} */ ((req, res, next) => {
    const key = keyOf(req);
    if (!key) return next();                 // 取不到身分／IP＝不限制（寧可放行，也不要誤擋正當使用者）
    const { allowed, retryAfterSec } = limiter.hit(key);
    if (allowed) return next();
    res.set('Retry-After', String(retryAfterSec));
    res.status(429).json({ error: message });
  });
  // 掛在中介層上供考題直接檢查／重置（不影響正式行為）
  /** @type {any} */ (mw).limiter = limiter;
  return mw;
}

/**
 * 取請求來源 IP。⚠️ **只有在 `trust proxy` 設對時 `req.ip` 才是真實客戶端 IP**——
 * Render 之類的平台會在前面代理，沒設的話所有請求看起來都來自同一個 IP，
 * 「每 IP 限制」會變成「全站共用一個額度」（把正當使用者一起擋掉）。設定在 server.js 的 HOSTED 分支。
 * @param {any} req @returns {string|null}
 */
export function ipKeyOf(req) {
  const ip = String(req?.ip || req?.socket?.remoteAddress || '').trim();
  return ip || null;
}
