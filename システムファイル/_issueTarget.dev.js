// SAKAE 問題点対策表：接続先の固定定義（DEV 用）。
// ★裁定 c：実行時のテーブル切替（window.SAKAE_ISSUE_TABLE 等の設定項目）は作らない。
//   本番用は _issueTarget.js（別ファイル）。どちらを読むかは HTML 側で固定する。
//   このファイルを読み込んだページは DEV 表にしか接続しない。
window.SAKAE_ISSUE_TARGET = Object.freeze({
  env: 'DEV',
  table: 'issue_countermeasures_dev',
  historyTable: 'issue_countermeasure_history_dev',
  authFn: 'sakae_is_dev_authorized',   // DEV allowlist（private.sakae_dev_users）を見る
  channel: 'issue_countermeasures_dev_changes',
  banner: 'DEV（試験用）— 本番の問題は表示されません',
  // ---- 試験用の確認者（榮製機側にあたる役）。本番の氏名は DEV には置かない ----
  reviewers: Object.freeze(['TEST-A','TEST-B'])
});
