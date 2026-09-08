// ============================================================
// Supabase接続設定（このファイルだけ、自分のSupabaseプロジェクトの値に書き換えてください）
//
// 値の場所：Supabaseの管理画面 → 左メニュー「Project Settings」→「API」
//   ・SAKAE_SUPABASE_URL    ← 「Project URL」をコピー
//   ・SAKAE_SUPABASE_ANON_KEY ← 「Project API keys」の中の「anon public」をコピー
//
// 注意：この anon key は「公開されても良い」種類のキーです（実際にブラウザの
// ソースに出ます）。アクセス制限は supabase_schema.sql で設定したRLS
// （ログインしている人だけ読み書きできる）の方で行っているので、
// このキー自体が漏れても、ログインなしでデータは読み書きできません。
// 逆に「service_role」というキーは絶対にここに書かない・使わないでください
// （そちらはRLSを無視して全データにアクセスできる管理者用の鍵です）。
// ============================================================
window.SAKAE_SUPABASE_URL = 'https://rtqntyliomtepxzosgnf.supabase.co';
window.SAKAE_SUPABASE_ANON_KEY = 'sb_publishable_mQYWmlKO0CC6fwq1s7ZTLA_-F-DZerg';

// テスト共有機能そのもののON/OFFスイッチ。
// falseにすると、今まで通りブラウザのlocalStorageだけで動きます（Supabase未設定でもエラーになりません）。
window.SAKAE_SYNC_ENABLED = true;
