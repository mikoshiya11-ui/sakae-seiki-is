// SAKAE 問題点対策表：接続先の固定定義（本番用）。
// ★裁定 c／②裁定 §2：実行時のテーブル切替は作らない。
//   window 変数／URL パラメータ／localStorage／query string による DEV・本番の切替は禁止。
//   DEV 用は _issueTarget.dev.js（別ファイル）。どちらを読むかは HTML 側で固定する。
//   このファイルを読み込んだページは本番表にしか接続しない（_dev 表へは到達しない）。
window.SAKAE_ISSUE_TARGET = Object.freeze({
  env: 'PROD',
  table: 'issue_countermeasures',
  historyTable: 'issue_countermeasure_history',
  authFn: 'sakae_is_authorized',       // 本番 allowlist（private.sakae_authorized_users）を見る
  channel: 'issue_countermeasures_changes',
  banner: '',                           // 本番では帯を出さない
  // ---- 「完了」にできる確認者（榮製機側）。2026-10-01 仕様変更 ----
  // 「完了」は榮製機側の確認 OK でのみ確定する。対策担当者（MIKOSHIYA 側）の自己確認では完了にしない。
  // ここは SAKAE 本番固有の設定なので、共通 JS（_issueCountermeasures.js）は人名を持たず、
  // 「許可された確認者か」だけを判定する。人の入れ替えはこのファイルだけで済む。
  reviewers: Object.freeze(['塩野','松井','菰田'])
});
