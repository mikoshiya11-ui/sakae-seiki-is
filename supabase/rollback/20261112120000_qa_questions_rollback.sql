-- SAKAE-QA-01 質問箱の巻き戻し（20261112120000_qa_questions.sql を取り消す）
--   ・1 つのトランザクションで行う（途中で失敗したら何も変わらない）。
--   ・質問が 1 件でもあれば、表は消さずに別の schema（qa_archive_YYYYMMDD_HHMMSS）へ退避する。
--     退避先は PostgREST に出していない schema で、anon・authenticated からは使えない（RLS も有効のまま）。
--   ・質問が 0 件なら表を消す。
--   ・kv_store・問題点対策表・許可リストには触れない。
--   ・本番では実行前に「02_DEV完成報告_入口の形」§6 の書き出しを先に行うこと（退避に加えて手元にも残す）。
begin;

-- 1) 入口と補助関数（表の型を引数に持つものがあるので、表より先に消す）
drop function if exists public.qa_escalate(text, text);
drop function if exists public.qa_answer(text, text, text);
drop function if exists public.qa_watch(timestamptz);
drop function if exists public.qa_resolve(text);
drop function if exists public.qa_list(text, boolean, integer);
drop function if exists public.qa_ask(text, text);
drop function if exists public.qa_me();
drop function if exists private.qa_row_json(public.qa_questions);
drop function if exists private.qa_is_closed(public.qa_questions);
drop function if exists private.qa_answerer_label();
drop function if exists private.qa_answerer_kind();

-- 2) 質問があれば退避、無ければ消す
do $$
declare
  v_n bigint := 0;
  v_s text;
begin
  if to_regclass('public.qa_questions') is not null then
    execute 'select count(*) from public.qa_questions' into v_n;
  end if;
  if v_n > 0 then
    v_s := 'qa_archive_' || to_char(now() at time zone 'Asia/Tokyo', 'YYYYMMDD_HH24MISS');
    execute format('create schema %I', v_s);
    execute format('revoke all on schema %I from public, anon, authenticated', v_s);
    execute format('alter table public.qa_answer_log set schema %I', v_s);
    execute format('alter table public.qa_questions set schema %I', v_s);
    if to_regclass('private.sakae_qa_answerers') is not null then
      execute format('alter table private.sakae_qa_answerers set schema %I', v_s);
    end if;
    raise notice 'qa rollback: % questions archived to schema %', v_n, v_s;
  end if;
end;
$$;

drop table if exists public.qa_answer_log;
drop table if exists public.qa_questions;
drop table if exists private.sakae_qa_answerers;

commit;
