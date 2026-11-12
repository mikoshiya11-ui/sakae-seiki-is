-- SAKAE-QA-01 質問箱の巻き戻し（20261112120000_qa_questions.sql を取り消す）
--   質問・回答の記録も消えるので、本番では実行前に public.qa_questions / public.qa_answer_log を書き出して残すこと。
--   kv_store・問題点対策表・許可リストには触れない。
drop function if exists public.qa_escalate(text, text);
drop function if exists public.qa_answer(text, text, text);
drop function if exists public.qa_watch(timestamptz);
drop function if exists public.qa_resolve(text);
drop function if exists public.qa_list(text, boolean, integer);
drop function if exists public.qa_ask(text, text);
drop function if exists public.qa_me();
drop function if exists private.qa_row_json(public.qa_questions);
drop table if exists public.qa_answer_log;
drop table if exists public.qa_questions;
drop function if exists private.qa_answerer_kind();
drop table if exists private.sakae_qa_answerers;
