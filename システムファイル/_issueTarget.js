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
  banner: ''                            // 本番では帯を出さない
});
