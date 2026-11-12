-- SAKAE-QA-01：質問箱（2026-11-12）
--   榮製機の人が画面で質問を書き、本部のハンチョー（AI）かテンチョーが答える。
--   設計：_指示書/SAKAE-QA-01_質問箱/質問箱_設計_榮製機_v1.md（三和の質問箱_設計_v1.md と同じ形）
--
-- 作り
--   表   public.qa_questions（質問 1 件 1 行・いまの回答）／public.qa_answer_log（回答・確認中・解決の記録。消さない）
--        private.sakae_qa_answerers（答えられる人。許可リストとは別）
--   入口 public.qa_ask / qa_list / qa_resolve / qa_watch / qa_answer / qa_escalate ／ 画面用 qa_me
--        すべて security definer・search_path=''。表そのものには anon・authenticated から一切触れない（RLS 有効・policy なし・grant なし）。
--
-- 守ること
--   ・kv_store・問題点対策表（issue_countermeasures*）・許可リスト（private.sakae_authorized_users）には触れない（読むのは判定関数だけ）。
--   ・質問できる・見られる人＝ private.is_sakae_authorized_user()（問題点対策表を使える人と同じ）。全員が全部見られる。
--   ・答えられる人＝ private.sakae_qa_answerers に載っている人だけ。専用ログイン（qa-hancho-sakae@…）は許可リストに入れず、ここにだけ載せる。
--   ・回答の種類は答える人に登録した種類（AI／HUMAN）と一致しないと書けない＝AI の回答を人の回答として出せない。
--   ・回数の制限：1 人 1 分に 3 件・1 日（日本時間）50 件。
--   ・14 日で「終了」は qa_list が返す表示だけ（定期の処理は作らない）。終了（解決・14 日）には AI は答えず、確認中にもしない。
--   ・AI は「確認中にしたあと人が答えていないもの」「人が最後に答えたもの」には答えない。解決（qa_resolve）は本人と HUMAN だけ。
--   ・1 問あたりの記録は AI が 20 件・人（HUMAN）が 40 件まで（AI が枠を埋めても人は答えられる）。確認中を重ねて記録しない。人が最後に答えた質問を AI は確認中に戻さない。
--   （2026-11-12 イインチョー審査 CONDITIONAL PASS の是正を反映）

-- ===== 1. 答えられる人 =====
create table if not exists private.sakae_qa_answerers (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('AI','HUMAN')),
  label      text not null check (char_length(label) between 1 and 40),
  created_at timestamptz not null default now()
);
revoke all on table private.sakae_qa_answerers from public, anon, authenticated;
-- RLS 有効・policy なし＝関数（定義者）以外からは読めない・書けない（イインチョー LOW）
alter table private.sakae_qa_answerers enable row level security;

create or replace function private.qa_answerer_kind()
returns text
language sql stable security definer
set search_path = ''
as $$
  select a.kind from private.sakae_qa_answerers a where a.user_id = (select auth.uid());
$$;
revoke all on function private.qa_answerer_kind() from public, anon, authenticated;

-- ===== 2. 表 =====
create table if not exists public.qa_questions (
  id              bigint generated always as identity primary key,
  qno             text generated always as ('Q-' || case when id < 10000 then lpad(id::text, 4, '0') else id::text end) stored unique,
  asker_uid       uuid references auth.users(id) on delete set null,
  asker_name      text not null check (char_length(asker_name) between 1 and 80),
  body            text not null check (char_length(btrim(body)) between 1 and 1000),
  page            text check (page is null or char_length(page) <= 200),
  status          text not null default 'NEW' check (status in ('NEW','ANSWERED','ESCALATED','CLOSED')),
  answer          text check (answer is null or char_length(answer) <= 2000),
  answer_kind     text check (answer_kind is null or answer_kind in ('AI','HUMAN')),
  answered_at     timestamptz,
  escalate_reason text check (escalate_reason is null or char_length(escalate_reason) <= 500),
  escalated_at    timestamptz,
  closed_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists qa_questions_updated_idx on public.qa_questions (updated_at, id);
create index if not exists qa_questions_asker_idx   on public.qa_questions (asker_uid, created_at desc);
create index if not exists qa_questions_status_idx  on public.qa_questions (status);

create table if not exists public.qa_answer_log (
  id          bigint generated always as identity primary key,
  question_id bigint not null references public.qa_questions(id) on delete cascade,
  action      text not null check (action in ('ANSWER','ESCALATE','RESOLVE')),
  kind        text check (kind is null or kind in ('AI','HUMAN')),
  text        text check (text is null or char_length(text) <= 2000),
  actor_uid   uuid references auth.users(id) on delete set null,
  -- 記録した時点の名義（答える人の表の label）を写して残す。あとで人を外しても名義は変わらない（イインチョー LOW）
  label       text check (label is null or char_length(label) <= 40),
  created_at  timestamptz not null default now()
);
create index if not exists qa_answer_log_q_idx on public.qa_answer_log (question_id, id);

alter table public.qa_questions  enable row level security;
alter table public.qa_answer_log enable row level security;
-- policy は作らない＝表へは入口（関数）からしか触れない
revoke all on table public.qa_questions  from public, anon, authenticated;
revoke all on table public.qa_answer_log from public, anon, authenticated;
revoke all on sequence public.qa_questions_id_seq  from public, anon, authenticated;
revoke all on sequence public.qa_answer_log_id_seq from public, anon, authenticated;

-- ===== 3. 返す形（qa_list と qa_watch で共通） =====
-- 1 件を json にする。status は 14 日を過ぎた回答済みを CLOSED として返す（DB の値は変えない）。answers は記録の古い順。
create or replace function private.qa_row_json(q public.qa_questions)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'qno', q.qno,
    'asker_name', q.asker_name,
    'mine', (q.asker_uid is not null and q.asker_uid = (select auth.uid())),
    'body', q.body,
    'page', q.page,
    'status', case when q.status = 'ANSWERED' and q.answered_at < now() - interval '14 days' then 'CLOSED' else q.status end,
    'stored_status', q.status,
    'answer', q.answer,
    'answer_kind', q.answer_kind,
    -- 回答した人の表示名（答える人の表の label。例：見越（ミコシヤ））。答える人を表から外したあとは null（画面は種類で出す）
    'answer_label', (select l.label from public.qa_answer_log l
                      where l.question_id = q.id and l.action = 'ANSWER' order by l.id desc limit 1),
    'answered_at', q.answered_at,
    -- 確認中の理由は答える人向けのメモ。答える人以外には返さない
    'escalate_reason', case when private.qa_answerer_kind() is not null then q.escalate_reason end,
    'escalated_at', q.escalated_at,
    'closed_at', q.closed_at,
    'created_at', q.created_at,
    'updated_at', q.updated_at,
    'answers', coalesce((
      select jsonb_agg(jsonb_build_object('action', l.action, 'kind', l.kind, 'label', l.label,
                                    'text', case when l.action = 'ESCALATE' and private.qa_answerer_kind() is null then null else l.text end,
                                    'at', l.created_at) order by l.id)
      from public.qa_answer_log l
      where l.question_id = q.id
    ), '[]'::jsonb)
  );
$$;
revoke all on function private.qa_row_json(public.qa_questions) from public, anon, authenticated;

-- 答える人の表示名（記録に写す）
create or replace function private.qa_answerer_label()
returns text
language sql stable security definer
set search_path = ''
as $$
  select a.label from private.sakae_qa_answerers a where a.user_id = (select auth.uid());
$$;
revoke all on function private.qa_answerer_label() from public, anon, authenticated;

-- 表示上の終了（解決済み、または回答から 14 日を過ぎた回答済み）
create or replace function private.qa_is_closed(q public.qa_questions)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select q.status = 'CLOSED' or (q.status = 'ANSWERED' and q.answered_at < now() - interval '14 days');
$$;
revoke all on function private.qa_is_closed(public.qa_questions) from public, anon, authenticated;

-- ===== 4. 入口 =====
-- 画面用：自分が質問できるか・答えられるか
create or replace function public.qa_me()
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'can_ask', coalesce(private.is_sakae_authorized_user(), false),
    'answer_kind', private.qa_answerer_kind()
  );
$$;

-- 質問する（許可リストの人だけ）
create or replace function public.qa_ask(p_body text, p_page text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_body text := btrim(coalesce(p_body, ''));
  v_page text := nullif(btrim(coalesce(p_page, '')), '');
  v_name text;
  v_min  int;
  v_day  int;
  v_row  public.qa_questions;
begin
  if v_uid is null or not coalesce(private.is_sakae_authorized_user(), false) then
    raise exception 'qa: not allowed' using errcode = '42501';
  end if;
  if char_length(v_body) < 1 or char_length(v_body) > 1000 then
    raise exception 'qa: body must be 1-1000 chars' using errcode = '22023';
  end if;
  if v_page is not null and char_length(v_page) > 200 then
    v_page := left(v_page, 200);
  end if;
  -- 同じ人の同時送信を 1 本ずつにしてから数える（回数の制限）
  perform pg_advisory_xact_lock(hashtextextended('qa_ask:' || v_uid::text, 0));
  select count(*) into v_min from public.qa_questions where asker_uid = v_uid and created_at > now() - interval '1 minute';
  if v_min >= 3 then
    raise exception 'qa: rate limit (3 per minute)' using errcode = 'P0001', hint = 'RATE_MINUTE';
  end if;
  select count(*) into v_day from public.qa_questions
   where asker_uid = v_uid and created_at >= (date_trunc('day', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo');
  if v_day >= 50 then
    raise exception 'qa: rate limit (50 per day)' using errcode = 'P0001', hint = 'RATE_DAY';
  end if;
  -- 表示名：ログインの氏名（Google の full_name／name）→ 無ければメールの @ の前
  select coalesce(
           nullif(btrim(u.raw_user_meta_data->>'full_name'), ''),
           nullif(btrim(u.raw_user_meta_data->>'name'), ''),
           nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
           '利用者')
    into v_name
    from auth.users u where u.id = v_uid;
  v_name := left(coalesce(v_name, '利用者'), 80);
  insert into public.qa_questions (asker_uid, asker_name, body, page)
  values (v_uid, v_name, v_body, v_page)
  returning * into v_row;
  return private.qa_row_json(v_row);
end;
$$;

-- 一覧（許可リストの人と答える人）。p_status：NEW/ANSWERED/ESCALATED/CLOSED/null（全部）。CLOSED は 14 日を過ぎた回答済みも含む
create or replace function public.qa_list(p_status text default null, p_mine boolean default false, p_limit integer default 100)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_lim int := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_out jsonb;
begin
  if v_uid is null or not (coalesce(private.is_sakae_authorized_user(), false) or private.qa_answerer_kind() is not null) then
    raise exception 'qa: not allowed' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('NEW','ANSWERED','ESCALATED','CLOSED') then
    raise exception 'qa: bad status' using errcode = '22023';
  end if;
  -- 新しい順。状態の絞り込みは表示の状態（14 日の終了を含む）で行い、そのあと件数で切る
  select coalesce(jsonb_agg(s.j order by s.id desc), '[]'::jsonb) into v_out
  from (
    select q.id, private.qa_row_json(q) as j
    from public.qa_questions q
    where (not coalesce(p_mine, false) or q.asker_uid = v_uid)
      and (p_status is null
           or (p_status = 'CLOSED' and (q.status = 'CLOSED' or (q.status = 'ANSWERED' and q.answered_at < now() - interval '14 days')))
           or (p_status = 'ANSWERED' and q.status = 'ANSWERED' and not (q.answered_at < now() - interval '14 days'))
           or (p_status in ('NEW','ESCALATED') and q.status = p_status))
    order by q.id desc
    limit v_lim
  ) s;
  return v_out;
end;
$$;

-- 解決にする（質問した本人か、答える人）
create or replace function public.qa_resolve(p_qno text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.qa_questions;
begin
  if v_uid is null then raise exception 'qa: not allowed' using errcode = '42501'; end if;
  select * into v_row from public.qa_questions where qno = p_qno for update;
  if not found then raise exception 'qa: not found' using errcode = 'P0002'; end if;
  -- 解決にできるのは質問した本人と人（HUMAN）の答える人だけ。AI は使えない（確認中を AI が解決→回答で回避できないように・イインチョー HIGH）
  -- null が混ざると判定が素通りになるので、全体を coalesce で false に倒す（asker_uid が null＝質問者が消えた行など）
  if not coalesce((v_row.asker_uid = v_uid and private.is_sakae_authorized_user()) or private.qa_answerer_kind() = 'HUMAN', false) then
    raise exception 'qa: not allowed' using errcode = '42501';
  end if;
  if v_row.status <> 'CLOSED' then
    update public.qa_questions set status = 'CLOSED', closed_at = now(), updated_at = now() where id = v_row.id returning * into v_row;
    insert into public.qa_answer_log (question_id, action, kind, label, actor_uid)
    values (v_row.id, 'RESOLVE', private.qa_answerer_kind(), private.qa_answerer_label(), v_uid);
  end if;
  return private.qa_row_json(v_row);
end;
$$;

-- 見張り役（答える人だけ）：{ now, items }。items＝状態 NEW のものは p_since に関係なく全部＋p_since より後に変わったもの（古い順）。
--   本部の PC が止まっていた間の質問を取りこぼさないため（本部 2026-11-12）。次の p_since は返した now から決める（賢者の書 sage_watch と同じ作り）。
create or replace function public.qa_watch(p_since timestamptz default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_items jsonb;
begin
  if (select auth.uid()) is null or private.qa_answerer_kind() is null then
    raise exception 'qa: not allowed' using errcode = '42501';
  end if;
  -- NEW は件数の枠の外で全部（最大 1000）を先に並べ、そのあとに p_since より後に変わったもの（最大 200・古い順）。本部の取りこぼし防止（イインチョー LOW）
  select coalesce(jsonb_agg(x.j order by x.grp, x.updated_at, x.id), '[]'::jsonb) into v_items
  from (
    (select 0 as grp, q.updated_at, q.id, private.qa_row_json(q) as j
       from public.qa_questions q where q.status = 'NEW' order by q.id limit 1000)
    union all
    (select 1 as grp, q.updated_at, q.id, private.qa_row_json(q) as j
       from public.qa_questions q
      where q.status <> 'NEW' and q.updated_at > coalesce(p_since, '-infinity'::timestamptz)
      order by q.updated_at, q.id limit 200)
  ) x;
  return jsonb_build_object('now', now(), 'items', v_items);
end;
$$;

-- 答える（答える人だけ）。p_kind は答える人に登録した種類と同じでないと書けない。前の回答は記録に残り、訂正は追記
create or replace function public.qa_answer(p_qno text, p_answer text, p_kind text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_kind text := private.qa_answerer_kind();
  v_text text := btrim(coalesce(p_answer, ''));
  v_row  public.qa_questions;
  v_esc  bigint;
  v_hum  bigint;
  v_closed boolean;
begin
  if v_uid is null or v_kind is null then raise exception 'qa: not allowed' using errcode = '42501'; end if;
  if p_kind is distinct from v_kind then raise exception 'qa: kind mismatch' using errcode = '42501'; end if;
  if char_length(v_text) < 1 or char_length(v_text) > 2000 then
    raise exception 'qa: answer must be 1-2000 chars' using errcode = '22023';
  end if;
  select * into v_row from public.qa_questions where qno = p_qno for update;
  if not found then raise exception 'qa: not found' using errcode = 'P0002'; end if;
  -- 1 問あたりの記録の上限：AI は 20 件・人（HUMAN）は 40 件（AI が枠を埋めても人は答えられる・イインチョー再審査 A）
  if (select count(*) from public.qa_answer_log l where l.question_id = v_row.id) >= (case when v_kind = 'AI' then 20 else 40 end) then
    raise exception 'qa: too many records for one question' using errcode = 'P0001', hint = 'LOG_LIMIT';
  end if;
  if v_kind = 'AI' then
    select max(l.id) into v_esc from public.qa_answer_log l where l.question_id = v_row.id and l.action = 'ESCALATE';
    select max(l.id) into v_hum from public.qa_answer_log l where l.question_id = v_row.id and l.action = 'ANSWER' and l.kind = 'HUMAN';
    -- 確認中にしたあと人が答えていないものに AI は答えない。状態が何であっても（解決・終了にしてからの回避を防ぐ・イインチョー HIGH）
    if v_row.status = 'ESCALATED' or (v_esc is not null and (v_hum is null or v_hum < v_esc)) then
      raise exception 'qa: escalated question is for a human answer' using errcode = '22023', hint = 'ESCALATED_HUMAN_ONLY';
    end if;
    -- 人が答えたあとに AI は追記しない（イインチョー MEDIUM）
    if v_hum is not null and v_hum = (select max(l.id) from public.qa_answer_log l where l.question_id = v_row.id and l.action = 'ANSWER') then
      raise exception 'qa: a human has answered' using errcode = '22023', hint = 'HUMAN_ANSWERED';
    end if;
    -- 終了（解決・14 日）したものに AI は答えない。人の追記はできる
    if private.qa_is_closed(v_row) then
      raise exception 'qa: closed question is for a human answer' using errcode = '22023', hint = 'CLOSED_HUMAN_ONLY';
    end if;
  end if;
  -- 表示上の終了（解決・14 日）に人が追記したら、状態を CLOSED に揃える（追記で「回答あり」に戻らない）
  v_closed := private.qa_is_closed(v_row);
  update public.qa_questions
     set answer = v_text, answer_kind = v_kind, answered_at = now(),
         status = case when v_closed then 'CLOSED' else 'ANSWERED' end,
         closed_at = case when v_closed then coalesce(closed_at, now()) else closed_at end,
         updated_at = now()
   where id = v_row.id returning * into v_row;
  insert into public.qa_answer_log (question_id, action, kind, label, text, actor_uid)
  values (v_row.id, 'ANSWER', v_kind, private.qa_answerer_label(), v_text, v_uid);
  return private.qa_row_json(v_row);
end;
$$;

-- 確認中にする（答える人だけ）。画面には「すみません、担当の見越に確認します。」と出す（理由は答える人向けの記録）
create or replace function public.qa_escalate(p_qno text, p_reason text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_kind text := private.qa_answerer_kind();
  v_why  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_row  public.qa_questions;
begin
  if v_uid is null or v_kind is null then raise exception 'qa: not allowed' using errcode = '42501'; end if;
  if v_why is not null and char_length(v_why) > 500 then v_why := left(v_why, 500); end if;
  select * into v_row from public.qa_questions where qno = p_qno for update;
  if not found then raise exception 'qa: not found' using errcode = 'P0002'; end if;
  -- 終了（解決・14 日を過ぎた回答済み）は確認中にしない（表示と揃える）
  if private.qa_is_closed(v_row) then raise exception 'qa: already closed' using errcode = '22023'; end if;
  -- すでに確認中なら記録を足さず、そのまま返す（イインチョー再審査 A）
  if v_row.status = 'ESCALATED' then
    return private.qa_row_json(v_row);
  end if;
  -- 人が最後に答えた質問を AI が確認中に戻すことはしない（イインチョー再審査 C）
  if v_kind = 'AI' and exists (
       select 1 from public.qa_answer_log l
        where l.question_id = v_row.id and l.action = 'ANSWER' and l.kind = 'HUMAN'
          and l.id = (select max(l2.id) from public.qa_answer_log l2 where l2.question_id = v_row.id and l2.action = 'ANSWER')) then
    raise exception 'qa: a human has answered' using errcode = '22023', hint = 'HUMAN_ANSWERED';
  end if;
  if (select count(*) from public.qa_answer_log l where l.question_id = v_row.id) >= (case when v_kind = 'AI' then 20 else 40 end) then
    raise exception 'qa: too many records for one question' using errcode = 'P0001', hint = 'LOG_LIMIT';
  end if;
  update public.qa_questions
     set status = 'ESCALATED', escalate_reason = v_why, escalated_at = now(), updated_at = now()
   where id = v_row.id returning * into v_row;
  insert into public.qa_answer_log (question_id, action, kind, label, text, actor_uid)
  values (v_row.id, 'ESCALATE', v_kind, private.qa_answerer_label(), v_why, v_uid);
  return private.qa_row_json(v_row);
end;
$$;

-- ===== 5. 入口の実行権限（ログインした人だけ。中で許可リスト／答える人を確かめる） =====
revoke all on function public.qa_me()                                  from public, anon;
revoke all on function public.qa_ask(text, text)                       from public, anon;
revoke all on function public.qa_list(text, boolean, integer)          from public, anon;
revoke all on function public.qa_resolve(text)                         from public, anon;
revoke all on function public.qa_watch(timestamptz)                    from public, anon;
revoke all on function public.qa_answer(text, text, text)              from public, anon;
revoke all on function public.qa_escalate(text, text)                  from public, anon;
grant execute on function public.qa_me()                               to authenticated;
grant execute on function public.qa_ask(text, text)                    to authenticated;
grant execute on function public.qa_list(text, boolean, integer)       to authenticated;
grant execute on function public.qa_resolve(text)                      to authenticated;
grant execute on function public.qa_watch(timestamptz)                 to authenticated;
grant execute on function public.qa_answer(text, text, text)           to authenticated;
grant execute on function public.qa_escalate(text, text)               to authenticated;
