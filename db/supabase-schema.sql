-- NotEasy HOSTED 模式的 Supabase Postgres 結構（C4b，2026-07-27）
-- ============================================================================
-- 這是 HOSTED（noteasy.com.tw）唯一的資料表定義。**LOCAL 模式完全用不到這個檔**
--（你的 Mac 上仍是 data/store.db，一行都不受影響）。
--
-- 怎麼用：在 Supabase Dashboard → SQL Editor 貼上整份執行（可重複執行，冪等）。
-- 之後每次改這個檔，都要在 Dashboard 重跑一次；**程式碼與資料庫結構的同步點就是這個檔**。
--
-- 設計原則（C0 五之二契約）：
--   ①**先搬形狀、不改語意**：沿用本機 SQLite 的 kv 形狀（一個 key 一列 JSON），只多兩欄——
--     `user_id`（租戶）與 `version`（樂觀鎖）。日後真有多人效能需求再正規化（現況單人 <1MB，YAGNI）。
--   ②**RLS 是第二道防線**：即使 app 層漏了 where 條件，資料庫層也回不了別人的列（P1-3）。
--   ③**service_role 不准碰這張表**（裁決⑥，不可退讓）：service_role 天生繞過 RLS，
--     一旦拿它讀寫一般資料，RLS 就形同虛設。它只准做邀請／admin 操作。
-- ============================================================================

-- ---- 1) 資料表 -------------------------------------------------------------
create table if not exists public.kv (
  -- 租戶。**預設值 auth.uid()**＝app 端永遠不必（也不該）自己填 user_id，
  -- 填錯／被竄改的可能性從結構上消失。
  user_id    uuid        not null default auth.uid(),
  -- 與 lib/store.js 的 KV_KEYS 同一組鍵（settings / learnedCategories / … / 各集合名）。
  key        text        not null,
  data       jsonb       not null,
  -- 樂觀鎖版本（P1-5）：每次成功寫入 +1。compare-and-swap 用它判斷「我讀的還是不是最新的」。
  version    bigint      not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

comment on table public.kv is 'NotEasy 每位使用者的整包理財資料（一個 key 一列 JSON）。隔離靠 RLS，並行安全靠 version 樂觀鎖。';

-- ---- 2) RLS：唯一的隔離真相 ------------------------------------------------
alter table public.kv enable row level security;
-- force＝連資料表擁有者也要守 RLS（少了這行，用 owner 身分連線就整張表全開）。
alter table public.kv force row level security;

-- ⚠️ P1-3 契約：**必須 FOR ALL，且 USING 與 WITH CHECK 兩者都寫**。
--   只寫 USING 只擋「讀」——A 仍然能 INSERT／UPDATE 出一列 user_id = B 的資料。
--   USING     ＝我能看見／能改動哪些列
--   WITH CHECK ＝我寫進去的列長什麼樣才被接受
drop policy if exists kv_owner_all on public.kv;
create policy kv_owner_all on public.kv
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---- 3) 權限：只有登入者本人，service_role 一律擋掉 ------------------------
revoke all on table public.kv from public;
revoke all on table public.kv from anon;
-- 裁決⑥：service_role 有 BYPASSRLS，但**沒有資料表權限就還是進不來**。
-- 真的需要人工救援時，臨時 grant、用完立刻 revoke（並在 PR/紀錄裡寫明原因與時間）。
revoke all on table public.kv from service_role;
grant select, insert, update, delete on table public.kv to authenticated;

-- ---- 4) 原子寫入：整包 read-modify-write 的 compare-and-swap ---------------
-- 為什麼要一支函式而不是逐列 update：app 端一次寫的是**整包資料**（全部 KV_KEYS），
-- 必須「全部成功或全部不動」；PostgREST 的逐列 update 做不到跨列原子性。
-- plpgsql 函式天生在單一交易裡跑＝全有或全無。
--
-- ⚠️ **security invoker（預設，這裡明寫出來）**：函式用「呼叫者」的身分跑，所以 RLS 照樣生效。
--    寫成 security definer 會讓這支函式變成繞過 RLS 的後門——絕對不可以。
--
-- 參數：
--   p_rows     jsonb 物件 {key: data}     這次要寫的全部 key
--   p_expected jsonb 物件 {key: version}  讀出來時的版本；該 key 當時不存在＝傳 null
-- 回傳：
--   成功 {"ok": true, "versions": {key: 新版本}}
--   版本不合＝丟例外 errcode 40001（app 端翻成 409）
create or replace function public.kv_save(p_rows jsonb, p_expected jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid      uuid := (select auth.uid());
  r          record;
  v_expected bigint;
  v_current  bigint;
  v_new      bigint;
  v_out      jsonb := '{}'::jsonb;
begin
  if v_uid is null then
    -- 沒有身分就一個字都不准寫（fail-closed；正常情況 authGate 早就擋掉了）
    raise exception '未登入，無法寫入' using errcode = '28000';
  end if;

  if jsonb_typeof(p_rows) is distinct from 'object' then
    raise exception 'kv_save: p_rows 必須是 JSON 物件' using errcode = '22023';
  end if;

  for r in select key, value from jsonb_each(p_rows) loop
    -- 期望版本：JSON null 或缺鍵都代表「我讀的時候這一列不存在」
    v_expected := case
      when p_expected is null then null
      when jsonb_typeof(p_expected -> r.key) in ('number') then (p_expected ->> r.key)::bigint
      else null
    end;

    select version into v_current
      from public.kv
     where user_id = v_uid and key = r.key
     for update;

    if v_expected is null then
      if v_current is not null then
        -- 我以為這列不存在，實際上別人已經建了 → 衝突
        raise exception '資料在你操作期間被另一個裝置改過（%）', r.key using errcode = '40001';
      end if;
      insert into public.kv (user_id, key, data, version)
           values (v_uid, r.key, r.value, 1)
        returning version into v_new;
    else
      if v_current is distinct from v_expected then
        raise exception '資料在你操作期間被另一個裝置改過（%）', r.key using errcode = '40001';
      end if;
      update public.kv
         set data = r.value, version = version + 1, updated_at = now()
       where user_id = v_uid and key = r.key
      returning version into v_new;
    end if;

    v_out := v_out || jsonb_build_object(r.key, v_new);
  end loop;

  return jsonb_build_object('ok', true, 'versions', v_out);
end;
$$;

revoke all on function public.kv_save(jsonb, jsonb) from public;
revoke all on function public.kv_save(jsonb, jsonb) from anon;
revoke all on function public.kv_save(jsonb, jsonb) from service_role;
grant execute on function public.kv_save(jsonb, jsonb) to authenticated;
