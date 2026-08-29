// ============================================================
// SAKAE SEIKI-iS テスト共有レイヤー（_sakaeSync.js）
//
// 各ページの中身のロジックは一切変更せず、「localStorageへの保存先」を
// ブラウザだけ → Supabase経由で全員に共有、に差し替えるための薄い仕組みです。
//
// やっていること：
//   1) ログインしていない人は自動でログイン画面へ飛ばす
//   2) ページを開いた時、Supabase上の最新データをlocalStorageに反映する
//   3) このページで何かを保存する（localStorage.setItem）たびに、自動でSupabaseにも送る
//   4) 他の人が保存したら、数秒以内にこのページにも反映する（リアルタイム購読）
//
// _sakaeSupabaseConfig.js で SAKAE_SYNC_ENABLED=false にすれば、
// 今まで通りブラウザだけで動く従来モードに戻ります（Supabase未設定でもエラーになりません）。
// ============================================================
// ============================================================
// 案件に紐づく保存キーの作り方（全画面で共通の正本）
//
// これまで「案件のキーを作る」処理が9ファイルに散らばっていて、
// 追加や変更のたびに片方だけ直され、食い違いが不具合になっていた
// （担当者名 checkNames の管理漏れ・TOPと同期層の二重管理など）。
// キーの作り方はここ1か所だけに置き、各画面はこの窓口を通す。
//
// このファイルは全ページが読み込むため、同期の設定が無い・オフの場合でも
// 使えるように、下の早期 return より前で定義する。
//
// ★いまは案件を「社内No.」で識別している（従来どおり）。
//   将来 records[].id で識別する形へ移す時も、直すのはこの1か所だけで済む。
// ============================================================
(function(){
  'use strict';

  // 案件に紐づくデータの種類。★この並び順は変えないこと。
  // 社内No.を変更したときの「旧キー→新キー」の対応付けが、この順番に依存している。
  const PRODUCT_KEY_BASES = {
    buhinhyo:          'sakaeIS_buhinhyoMock_v1',          // 作業票（部品表）
    kobetsuMemos:      'sakaeIS_kobetsuMock_memos_v1',     // 個別日程表 メモ
    kobetsuView:       'sakaeIS_kobetsuMock_view_v1',      // 個別日程表 表示期間
    kobetsuRowcounts:  'sakaeIS_kobetsuMock_rowcounts_v1', // 個別日程表 行数
    kobetsuLaneassign: 'sakaeIS_kobetsuMock_laneassign_v1',// 個別日程表 レーン割当
    kobetsuLegacybars: 'sakaeIS_kobetsuMock_legacybars_v1',// 個別日程表 旧バー
    kobetsuChecks:     'sakaeIS_kobetsuMock_checks_v1',    // 個別日程表 進捗チェック
    kobetsuCheckNames: 'sakaeIS_kobetsuMock_checkNames_v1',// 個別日程表 担当者の名前一覧
    kobetsuConfirm:    'sakaeIS_kobetsuMock_confirm_v1',   // 個別日程表 計画確定
    shikyuNouhin:      'sakaeIS_shikyuNouhinBoard_v2'      // 支給・納品一覧（製品単位）
  };
  const PRODUCT_KEY_TYPES = Object.keys(PRODUCT_KEY_BASES);

  // ============================================================
  // Phase 2A：recordId ベースの保存キー（v2）
  //
  // v1（従来）＝ 社内No. で案件を識別する      sakaeIS_buhinhyoMock_v1_35480001-11
  // v2（新設）＝ records[].id で案件を識別する  sakaeIS_buhinhyoMock_rid_ab12cd34
  //
  // ★「v2」なのに末尾が _v2_ ではなく _rid_ なのは、支給納品一覧だけ従来キーが
  //   すでに sakaeIS_shikyuNouhinBoard_v2_<社内No.> だからである。
  //   ここで版番号を1つ上げると、支給納品だけ新旧が同じ形になって区別できなくなる。
  //   「曖昧なものを推測で判定しない」というのが Phase 2 の原則なので、
  //   全種別で未使用の _rid_ を使い、キーを見ただけで正本が分かるようにする。
  //
  // ★この表を差し替えれば命名は全画面まとめて変わる。各画面は文字列を組み立てない。
  // ============================================================
  const PRODUCT_KEY_BASES_V2 = {
    buhinhyo:          'sakaeIS_buhinhyoMock_rid',
    kobetsuMemos:      'sakaeIS_kobetsuMock_memos_rid',
    kobetsuView:       'sakaeIS_kobetsuMock_view_rid',
    kobetsuRowcounts:  'sakaeIS_kobetsuMock_rowcounts_rid',
    kobetsuLaneassign: 'sakaeIS_kobetsuMock_laneassign_rid',
    kobetsuLegacybars: 'sakaeIS_kobetsuMock_legacybars_rid',
    kobetsuChecks:     'sakaeIS_kobetsuMock_checks_rid',
    kobetsuCheckNames: 'sakaeIS_kobetsuMock_checkNames_rid',
    kobetsuConfirm:    'sakaeIS_kobetsuMock_confirm_rid',
    shikyuNouhin:      'sakaeIS_shikyuNouhinBoard_rid'
  };

  // 削除の墓標。構造も方式も変えない（recordId ＋ deletionId のまま）。
  // 「その案件が生きているか」を案件の解決で使うので、ここに置いて全画面で1つにする。
  const TOMB_PREFIX = 'sakaeIS_deletedRecord_v1_';
  const TOMB_UNDO_PREFIX = 'sakaeIS_deletedRecordUndo_v1_';

  function baseOf(type){
    const b = PRODUCT_KEY_BASES[type];
    if(!b) throw new Error('[sakaeKeys] 知らない案件データの種類です: ' + type);
    return b;
  }

  function baseOfV2(type){
    const b = PRODUCT_KEY_BASES_V2[type];
    if(!b) throw new Error('[sakaeKeys] 知らない案件データの種類です: ' + type);
    return b;
  }

  // 墓標キーから recordId と deletionId を取り出す（TOP・同期層と同じ切り方）
  function splitEventKey(key, prefix){
    const rest = key.slice(prefix.length);
    const i = rest.indexOf('_');
    if(i < 1 || i === rest.length-1) return null;
    return { recordId: rest.slice(0, i), deletionId: rest.slice(i+1) };
  }

  window.sakaeKeys = {
    RECORDS_KEY: 'sakaeIS_records_v1',
    PRODUCT_KEY_TYPES: PRODUCT_KEY_TYPES.slice(),

    // 1件ぶんのキー（例：sakaeIS_buhinhyoMock_v1_35480001-11）
    productKey: function(type, productNo){ return baseOf(type) + '_' + productNo; },

    // 品番が無いときは末尾を付けない。個別日程表を品番なしで開いた時の従来動作をそのまま残す。
    productKeyNs: function(type, productNo){
      return baseOf(type) + (productNo ? ('_' + productNo) : '');
    },

    // 前方一致で使う「種類ごとの頭」（例：sakaeIS_buhinhyoMock_v1_）
    productKeyPrefix: function(type){ return baseOf(type) + '_'; },
    productKeyPrefixes: function(){ return PRODUCT_KEY_TYPES.map(function(t){ return baseOf(t) + '_'; }); },

    // その案件に紐づくキー一式。★並び順は PRODUCT_KEY_TYPES のとおり
    productDataKeys: function(productNo){
      if(!productNo) return [];
      return PRODUCT_KEY_TYPES.map(function(t){ return baseOf(t) + '_' + productNo; });
    },

    // キー名から社内No.を取り出す。案件に紐づかないキーなら空文字。
    // 「末尾が社内No.か」で判定すると sakaeIS_ncGanttMock_bars_v1_<工程コード> のような
    // 案件と無関係のキーまで拾ってしまうため、必ずこの明示リストの前方一致で判定する。
    productNoOfKey: function(key){
      if(typeof key !== 'string') return '';
      for(let i=0;i<PRODUCT_KEY_TYPES.length;i++){
        const p = baseOf(PRODUCT_KEY_TYPES[i]) + '_';
        if(key.indexOf(p) === 0) return key.slice(p.length);
      }
      return '';
    },

    // ========================================================
    // ここから Phase 2A で追加した分。
    // ★いまはどの画面もここを呼んでいない（業務挙動は変わらない）。
    //   画面を切り替えるのは Phase 2B 以降。
    // ========================================================
    TOMB_PREFIX: TOMB_PREFIX,
    TOMB_UNDO_PREFIX: TOMB_UNDO_PREFIX,

    // v1（社内No.ベース）。productKey と同じもので、呼ぶ側で新旧が読み取れるように名前を付けた
    v1Key: function(type, productNo){ return baseOf(type) + '_' + productNo; },
    v1KeyPrefix: function(type){ return baseOf(type) + '_'; },

    // v2（recordIdベース）
    v2Key: function(type, recordId){
      if(!recordId) throw new Error('[sakaeKeys] recordId が空です: ' + type);
      return baseOfV2(type) + '_' + recordId;
    },
    v2KeyPrefix: function(type){ return baseOfV2(type) + '_'; },
    v2KeyPrefixes: function(){ return PRODUCT_KEY_TYPES.map(function(t){ return baseOfV2(t) + '_'; }); },

    // その案件のv2キー一式。★並び順は v1 の productDataKeys と同じ
    v2DataKeys: function(recordId){
      if(!recordId) return [];
      return PRODUCT_KEY_TYPES.map(function(t){ return baseOfV2(t) + '_' + recordId; });
    },

    // キー名から recordId を取り出す。v2キーでなければ空文字
    recordIdOfKey: function(key){
      if(typeof key !== 'string') return '';
      for(let i=0;i<PRODUCT_KEY_TYPES.length;i++){
        const p = baseOfV2(PRODUCT_KEY_TYPES[i]) + '_';
        if(key.indexOf(p) === 0) return key.slice(p.length);
      }
      return '';
    },
    isV2Key: function(key){ return !!window.sakaeKeys.recordIdOfKey(key); },

    // ---- 案件一覧 ----
    loadRecords: function(){
      try{
        const raw = localStorage.getItem('sakaeIS_records_v1');
        if(!raw) return [];
        const a = JSON.parse(raw);
        return Array.isArray(a) ? a : [];
      }catch(e){ return []; }
    },

    // 有効な削除（取消されていない墓標）の recordId 一式。
    // 削除された案件は「生きている案件」に数えないために使う。
    activeDeletedRecordIds: function(){
      const dels = [];
      const undone = {};
      for(let i=0;i<localStorage.length;i++){
        const k = localStorage.key(i);
        if(!k) continue;
        if(k.indexOf(TOMB_UNDO_PREFIX) === 0){
          const p = splitEventKey(k, TOMB_UNDO_PREFIX);
          if(p) undone[p.recordId + '_' + p.deletionId] = true;
        }else if(k.indexOf(TOMB_PREFIX) === 0){
          const p = splitEventKey(k, TOMB_PREFIX);
          if(p) dels.push(p);
        }
      }
      const ids = {};
      dels.forEach(function(d){
        if(undone[d.recordId + '_' + d.deletionId]) return;
        ids[d.recordId] = true;
      });
      return ids;
    },

    // ---- 社内No. → recordId の解決 ----
    // 返す状態は3つだけ。
    //   ok        生きている案件がちょうど1件 … v2を使ってよい・移行してよい
    //   none      該当なし／recordId が無い    … v1のまま（今日と同じ挙動）
    //   ambiguous 同じ社内No.の案件が2件以上   … v1のまま・移行しない（人間の判断が要る）
    //
    // ★ambiguous で「どちらかに寄せる」ことは絶対にしない。
    //   v1データは社内No.にしか紐づいておらず、AとBのどちらのものかキーからも中身からも決められない。
    //   両方へコピーすると、片方を直したのに両方変わる／消したのに片方残る、という壊れ方をする。
    resolveRecordId: function(productNo){
      const no = (productNo == null) ? '' : String(productNo);
      if(!no) return { state:'none', recordId:'', candidates:[], reason:'社内No.が空' };
      const dead = window.sakaeKeys.activeDeletedRecordIds();
      const hits = window.sakaeKeys.loadRecords().filter(function(r){
        if(!r || String(r.productNo || '') !== no) return false;
        if(r.id && dead[r.id]) return false;   // 削除済みは数えない
        return true;
      });
      if(hits.length === 0) return { state:'none', recordId:'', candidates:[], reason:'この社内No.の案件が無い' };
      if(hits.length > 1){
        return {
          state:'ambiguous', recordId:'',
          candidates: hits.map(function(r){ return r.id || ''; }),
          reason:'同じ社内No.の案件が ' + hits.length + ' 件ある'
        };
      }
      if(!hits[0].id) return { state:'none', recordId:'', candidates:[], reason:'この案件に recordId が無い（古いJSON由来）' };
      return { state:'ok', recordId: hits[0].id, candidates:[hits[0].id], reason:'' };
    },

    // ---- 互換読込：v2優先 → 無ければ v1 ----
    // ★読んだだけでは移行しない（ページを開いただけで大量の旧キーを書き換えない）
    readProductData: function(type, productNo){
      const r = window.sakaeKeys.resolveRecordId(productNo);
      if(r.state === 'ok'){
        const k2 = window.sakaeKeys.v2Key(type, r.recordId);
        const v2 = localStorage.getItem(k2);
        if(v2 !== null) return { value:v2, from:'v2', key:k2, recordId:r.recordId, state:r.state };
      }
      const k1 = window.sakaeKeys.v1Key(type, productNo);
      const v1 = localStorage.getItem(k1);
      return { value:v1, from:(v1 === null ? null : 'v1'), key:k1, recordId:r.recordId, state:r.state, reason:r.reason };
    },

    // ---- 保存（touch migration）----
    // 順序は絶対に次のとおり。v1削除 → v2保存 の順にはしない。
    //   ① v2へ保存 → ② 読み戻して一致を確認 → ③ 一致したときだけ v1 を削除
    // 途中で失敗しても旧データは失わない。
    writeProductData: function(type, productNo, value){
      const raw = (typeof value === 'string') ? value : JSON.stringify(value);
      const r = window.sakaeKeys.resolveRecordId(productNo);
      const k1 = window.sakaeKeys.v1Key(type, productNo);

      // 解決できない・曖昧 → 従来どおり v1 へ保存する（今日とまったく同じ挙動）
      if(r.state !== 'ok'){
        localStorage.setItem(k1, raw);
        return { ok:true, wrote:'v1', key:k1, migrated:false, state:r.state, reason:r.reason };
      }

      const k2 = window.sakaeKeys.v2Key(type, r.recordId);
      const hadV1 = localStorage.getItem(k1) !== null;

      // ① v2へ保存
      try{
        localStorage.setItem(k2, raw);
      }catch(e){
        // 保存できなかった＝v1は無傷（ケースA）
        return { ok:false, wrote:null, key:k1, migrated:false, state:r.state, error:'v2保存に失敗: ' + (e && e.message) };
      }

      // ② 読み戻し確認
      if(localStorage.getItem(k2) !== raw){
        // 書けたつもりで中身が違う。v2を信用できないので取り除き、v1を残す（ケースB）
        try{ localStorage.removeItem(k2); }catch(e){}
        return { ok:false, wrote:null, key:k1, migrated:false, state:r.state, error:'v2の読み戻しが一致しない' };
      }

      // ③ 一致したときだけ v1 を削除
      if(hadV1) localStorage.removeItem(k1);
      return { ok:true, wrote:'v2', key:k2, migrated:hadV1, state:r.state, recordId:r.recordId };
    },

    // ---- 取り残された v1 の掃除（ケースD）----
    // v2が正しく在ることを確認できたときだけ v1 を消す。曖昧なら何もしない。
    cleanupLegacy: function(type, productNo){
      const r = window.sakaeKeys.resolveRecordId(productNo);
      if(r.state !== 'ok') return { removed:false, state:r.state, reason:r.reason };
      const k1 = window.sakaeKeys.v1Key(type, productNo);
      const k2 = window.sakaeKeys.v2Key(type, r.recordId);
      if(localStorage.getItem(k2) === null) return { removed:false, state:r.state, reason:'v2が無い' };
      if(localStorage.getItem(k1) === null) return { removed:false, state:r.state, reason:'v1が無い' };
      localStorage.removeItem(k1);
      return { removed:true, state:r.state, key:k1 };
    }
  };
})();

// ============================================================
// Phase 2B：画面遷移で「どの案件を開いているか」を決める共通の窓口
//
// これまで各画面は URL の ?productNo=（＝社内No.）だけで案件を決めていた。
// 社内No.は業務番号なので、同じ番号の案件が2件できてしまうと
// どちらを開いているのか決められない（実際に圏外での同時作成やJSON読込で起こりうる）。
//
// そこで URL に recordId（records[].id）を足し、そちらを案件識別の正本にする。
//   ?productNo=<社内No.>&recordId=<records[].id>
//
// ★recordId が URL にあるときは、社内No.から案件を推測しない。
//   必ず recordId で records を探す。同じ社内No.の別案件があっても選ばない。
// ★社内No.は表示・帳票・旧URL互換のために残す。
//
// ★Phase 2B では保存先は従来のまま（社内No.ベース）。
//   recordId 保存への切り替えは Phase 2C 以降。
// ============================================================
(function(){
  'use strict';

  const PARAM_PRODUCT_NO = 'productNo';
  const PARAM_RECORD_ID  = 'recordId';

  // recordId は uid() が作る英数字。URLから来るので中身を信用せず形だけ先に見る。
  // 文字列連結でキーを組み立てる前にここで弾く。
  const RECORD_ID_RE = /^[0-9A-Za-z]{1,32}$/;

  function isValidRecordId(v){
    return typeof v === 'string' && RECORD_ID_RE.test(v);
  }

  // 生きている案件だけを見る（有効な墓標がある＝削除済みは数えない）
  function livingRecords(){
    const dead = window.sakaeKeys.activeDeletedRecordIds();
    return window.sakaeKeys.loadRecords().filter(function(r){
      return r && !(r.id && dead[r.id]);
    });
  }

  function result(o){
    return Object.assign({
      state: 'unresolved',   // resolved / legacy / ambiguous / unresolved / conflict
      source: null,          // 'recordId' / 'productNo'
      usable: false,         // この社内No.でデータを読み書きしてよいか
      recordId: '',
      productNo: '',         // ★データアクセスに使ってよい社内No.。安全でないときは空
      urlProductNo: '',      // URLに書かれていた値（表示・診断用）
      record: null,
      candidates: [],
      stale: false,
      reason: ''
    }, o);
  }

  // ---- 案件の解決 ----
  function resolve(search){
    const p = new URLSearchParams(search || '');
    const rid = (p.get(PARAM_RECORD_ID) || '').trim();
    const urlNo = (p.get(PARAM_PRODUCT_NO) || '').trim();

    // ---------- recordId がある：これが正本 ----------
    if(rid){
      if(!isValidRecordId(rid)){
        // 形が想定外。社内No.へ落とすと別案件を開いてしまうので落とさない。
        return result({ state:'unresolved', urlProductNo:urlNo, reason:'recordId の形式が不正です' });
      }
      const hits = livingRecords().filter(function(r){ return r.id === rid; });
      if(hits.length === 1){
        const rec = hits[0];
        const no = String(rec.productNo || '');
        return result({
          state:'resolved', source:'recordId', usable: !!no,
          recordId: rid, productNo: no, urlProductNo: urlNo, record: rec,
          candidates:[rid],
          // 社内No.を変えたあとの古いリンクなど。records 側の最新を正本にする。
          stale: !!(urlNo && urlNo !== no),
          reason: (urlNo && urlNo !== no) ? 'URLの社内No.が古い（records の最新を使う）' : ''
        });
      }
      if(hits.length === 0){
        // ★社内No.へ勝手に落とさない。落とすと同じ社内No.の別案件を開いてしまう。
        return result({ state:'unresolved', recordId:rid, urlProductNo:urlNo,
          reason:'指定された案件が見つかりません（削除された可能性があります）' });
      }
      // 同じ id が複数ある。本来ありえない異常なので、どれも選ばない。
      return result({ state:'conflict', recordId:rid, urlProductNo:urlNo,
        candidates: hits.map(function(r){ return r.id; }),
        reason:'同じ recordId の案件が ' + hits.length + ' 件あります（異常）' });
    }

    // ---------- recordId が無い：従来どおり社内No.で解決 ----------
    if(!urlNo){
      return result({ state:'unresolved', reason:'案件が指定されていません' });
    }
    const hits = livingRecords().filter(function(r){ return String(r.productNo || '') === urlNo; });
    if(hits.length === 1){
      return result({
        state:'resolved', source:'productNo', usable:true,
        recordId: hits[0].id || '', productNo: urlNo, urlProductNo: urlNo, record: hits[0],
        candidates: hits[0].id ? [hits[0].id] : []
      });
    }
    if(hits.length === 0){
      // 案件カードがまだ無い状態（新規作成の途中など）。従来どおり社内No.で動かす。
      return result({
        state:'legacy', source:'productNo', usable:true,
        productNo: urlNo, urlProductNo: urlNo,
        reason:'この社内No.の案件カードがまだありません（従来どおり社内No.で動きます）'
      });
    }
    // ★同じ社内No.の案件が複数。配列順・更新時刻・先頭一致などで選ぶのは禁止。
    return result({
      state:'ambiguous', urlProductNo: urlNo,
      candidates: hits.map(function(r){ return r.id || ''; }),
      reason:'同じ社内No.の案件が ' + hits.length + ' 件あります'
    });
  }

  function resolveFromLocation(){ return resolve(location.search); }

  // ---- 遷移先へ渡すURLの作り方（各画面で組み立てない）----
  function query(ctx){
    const no  = (ctx && (ctx.productNo || ctx.urlProductNo)) || '';
    const rid = (ctx && ctx.recordId) || '';
    let q = PARAM_PRODUCT_NO + '=' + encodeURIComponent(no);
    if(rid) q += '&' + PARAM_RECORD_ID + '=' + encodeURIComponent(rid);
    return q;
  }
  function withCase(url, ctx){
    const q = query(ctx);
    if(!q) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + q;
  }

  // ---- 案件を特定できないときの案内 ----
  // 「指定が無い」だけなら従来どおりの文言。取り違えの危険があるときだけ別の案内にする。
  function emptyMessage(ctx){
    if(!ctx || ctx.usable) return '';
    if(ctx.state === 'ambiguous') return '案件を特定できません。案件一覧から開き直してください。';
    if(ctx.state === 'conflict')  return '案件を特定できません。案件一覧から開き直してください。';
    if(ctx.recordId)              return '指定された案件が見つかりません。案件一覧から開き直してください。';
    return '品番が指定されていません。';
  }

  // 取り違えの危険があるときは、データに触れる前にページを止める。
  // 「指定が無いだけ」の場合は従来の空表示に任せるため false を返す。
  function blockIfUnsafe(ctx){
    if(!ctx || ctx.usable) return false;
    if(ctx.state !== 'ambiguous' && ctx.state !== 'conflict' && !ctx.recordId) return false;
    try{
      const box = document.createElement('div');
      box.setAttribute('data-sakae-case-notice', ctx.state);
      box.style.cssText = 'margin:24px;padding:20px 24px;border:1px solid #d8dde5;border-radius:8px;'
        + 'background:#fff;color:#2a3446;font-size:15px;line-height:1.8;max-width:720px;';
      const msg = document.createElement('div');
      msg.textContent = emptyMessage(ctx);
      const why = document.createElement('div');
      why.style.cssText = 'margin-top:8px;color:#6b7684;font-size:13px;';
      why.textContent = ctx.reason || '';
      box.appendChild(msg);
      if(ctx.reason) box.appendChild(why);
      const put = function(){ document.body.innerHTML = ''; document.body.appendChild(box); };
      if(document.body) put(); else document.addEventListener('DOMContentLoaded', put);
    }catch(e){}
    return true;
  }

  window.sakaeCase = {
    PARAM_PRODUCT_NO: PARAM_PRODUCT_NO,
    PARAM_RECORD_ID: PARAM_RECORD_ID,
    isValidRecordId: isValidRecordId,
    resolve: resolve,
    resolveFromLocation: resolveFromLocation,
    query: query,
    withCase: withCase,
    emptyMessage: emptyMessage,
    blockIfUnsafe: blockIfUnsafe
  };
})();

(function(){
  'use strict';

  if(typeof window.SAKAE_SYNC_ENABLED !== 'undefined' && !window.SAKAE_SYNC_ENABLED) return;
  if(!window.SAKAE_SUPABASE_URL || !window.SAKAE_SUPABASE_ANON_KEY){
    console.warn('[sakaeSync] _sakaeSupabaseConfig.js が読み込まれていない、または未設定のため、共有機能はオフのまま動作します。');
    return;
  }
  // ログイン画面自身はこの仕組みでガードしない（無限リダイレクトになるため）
  if(document.documentElement.dataset.sakaeAuthPage === 'login') return;

  const KEY_PREFIX = 'sakaeIS_';
  const LOGIN_PAGE = _sakaePathTo('ログイン.html');

  // ---- 削除の墓標 ----
  // 削除された案件を全端末で永続的に覚えておくためのキー（案件1件につき1キー）。
  // 中身の意味づけと作成・取り消しは SAKAE SEIKI-iS.html 側にあり、ここでやるのは次の2つだけ。
  //   ① 初回同期では墓標を最初に取り込む（あとの判断がすべて墓標の上で行われるようにする）
  //   ② 墓標のある案件の古いデータキーを、共有側へ送り返さない
  // ②が必要なのは、下の initialSync が「共有に無い＝まだ送っていない」と決め打っているため。
  // 削除で消したキーと、まだ送っていないキーが区別できず、削除を知らない端末が
  // ページを開いただけで消したはずのデータを共有へ戻していた。
  // 墓標のキーの形は、案件の生死判定で全画面が使うため共通の窓口（このファイル冒頭）に置いてある。
  // 値も構造も従来のまま。ここではそれを受け取るだけで、墓標の方式は何も変えていない。
  const TOMB_PREFIX = window.sakaeKeys.TOMB_PREFIX;
  const TOMB_UNDO_PREFIX = window.sakaeKeys.TOMB_UNDO_PREFIX;
  const RECORDS_KEY = window.sakaeKeys.RECORDS_KEY;
  // 削除イベントと取消イベントの両方をまとめて「墓標の記録」として扱う
  function isTombKey(key){
    return typeof key === 'string'
      && (key.indexOf(TOMB_PREFIX) === 0 || key.indexOf(TOMB_UNDO_PREFIX) === 0);
  }
  function splitEventKey(key, prefix){
    const rest = key.slice(prefix.length);
    const i = rest.indexOf('_');
    if(i < 1 || i === rest.length-1) return null;
    return { recordId: rest.slice(0, i), deletionId: rest.slice(i+1) };
  }
  // 案件に紐づくキーかどうかの判定は、共通の窓口（このファイル冒頭の sakaeKeys）に任せる
  function productNoOfKey(key){ return window.sakaeKeys.productNoOfKey(key); }
  function parseRecordList(v){
    try{
      const a = (typeof v === 'string') ? JSON.parse(v) : v;
      return Array.isArray(a) ? a : [];
    }catch(e){ return []; }
  }

  // ---- 案件一覧を、共有の内容とこの端末の内容から安全に併合する ----
  // 案件一覧は配列まるごと1キーなので、共有の内容をそのまま採ると
  // 「つながっていない間にこの端末で作った案件」が消えてしまう。
  // かといって、この端末にあるものを何でも足すと、削除を知らない端末が
  // 消された案件を復活させてしまう。そこで足すのは次の両方を満たすものだけにする。
  //   ・共有側がその recordId をまったく知らない（＝この端末で作られたばかり）
  //     共有が知っている id は、共有側の内容が正しい（社内No.を変えた直後など）
  //   ・有効な削除イベントが無い（＝消された案件ではない）
  function mergeRecordsForInitialSync(remoteList, localList, tombRecordIds){
    const known = new Set();
    remoteList.forEach(r=>{ if(r && r.id) known.add(r.id); });
    const list = remoteList.slice();
    let added = 0;
    localList.forEach(r=>{
      if(!r || !r.id) return;
      if(known.has(r.id)) return;          // 共有が知っている案件
      if(tombRecordIds.has(r.id)) return;  // 消された案件
      list.unshift(r);                     // この端末にしか無い＝ここで作られた案件
      added++;
    });
    return { list: list, added: added };
  }

  // ---- ページ上のどこにあっても、システムファイル直下の共通ファイルを指せるようにする ----
  function _sakaePathTo(filename){
    // このスクリプト自身のsrc（システムファイル直下 or 各工程の日程表からの相対パス）から、
    // 同じフォルダにあるはずのfilenameへの相対パスを組み立てる
    const scripts = document.getElementsByTagName('script');
    for(let i=0;i<scripts.length;i++){
      const src = scripts[i].getAttribute('src') || '';
      if(src.indexOf('_sakaeSync.js') !== -1){
        return src.replace('_sakaeSync.js', filename);
      }
    }
    return filename; // 見つからなければ同じフォルダにある想定でそのまま
  }

  // ---- 認証確認が終わるまで、画面を白いオーバーレイで隠す（未ログイン状態の画面がチラ見えするのを防ぐ） ----
  // gateHidden: 認証確認が終わったかどうか。取り付けより先に hideGate() が呼ばれた場合に、
  // 後からオーバーレイを出してしまわないためのフラグ（これが無いと「ログイン状態を確認しています…」が消えなくなる）。
  let gateHidden = false;
  function showGate(message){
    if(gateHidden) return;                       // 既に確認が終わっているなら出さない
    let el = document.getElementById('sakaeAuthGate');
    if(!el){
      el = document.createElement('div');
      el.id = 'sakaeAuthGate';
      el.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#f4f6fa;display:flex;align-items:center;justify-content:center;font-family:"Hiragino Sans","Yu Gothic",-apple-system,BlinkMacSystemFont,sans-serif;color:#5b6b84;font-size:14px;';
      el.textContent = message || '確認中…';
      // documentElement（<html>）はこのスクリプトが動く時点で必ず存在するため、
      // body の生成や DOMContentLoaded を待たずにその場で取り付ける。
      // 待つ実装にすると、取り付け前に認証確認が終わった場合に hideGate() が空振りし、
      // そのあとオーバーレイだけが貼られて消えなくなる。
      document.documentElement.appendChild(el);
    }
  }
  function hideGate(){
    gateHidden = true;
    const el = document.getElementById('sakaeAuthGate');
    if(el) el.remove();
  }
  showGate('ログイン状態を確認しています…');

  // ---- Supabaseクライアント本体（CDNから動的読み込み） ----
  function loadScript(src){
    return new Promise((resolve, reject)=>{
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = ()=> reject(new Error('failed to load '+src));
      document.head.appendChild(s);
    });
  }

  let sb = null;
  let applyingRemoteUpdate = false; // 受信した更新をlocalStorageへ書き込んでいる最中は、push処理を発火させないためのフラグ
  const pushTimers = {}; // キーごとのデバウンス用タイマー
  const pendingActions = {}; // キーごとの「まだSupabaseに送っていない処理」（flush用に、タイマーとは別に本体を持っておく）
  const PUSH_DEBOUNCE_MS = 500;

  function isSyncKey(key){
    return typeof key === 'string' && key.indexOf(KEY_PREFIX) === 0;
  }

  // ---- ページ遷移などの直前に、まだデバウンス待ちのSupabase送信をすべて即時実行する。
  // 500msのデバウンスを待たずにページが破棄されると、直前の変更がSupabase側（＝他の端末）に届かないまま
  // 消えてしまうことがあるため、「作業票⇄受注に関する連絡書」など画面をまたぐ主要な遷移の直前に呼び出す想定。
  // 対象キーが無ければ何もせず即座に解決する。個々の送信が失敗しても他のキーの送信は続行する。 ----
  window.sakaeSyncFlush = async function(){
    const keys = Object.keys(pendingActions);
    if(!keys.length) return;
    const jobs = keys.map(k=>{
      const fn = pendingActions[k];
      if(pushTimers[k]){ clearTimeout(pushTimers[k]); delete pushTimers[k]; }
      delete pendingActions[k];
      if(!fn) return Promise.resolve();
      try{ return Promise.resolve(fn()).catch(e=>{ console.warn('[sakaeSync] flush失敗:', k, e); }); }
      catch(e){ console.warn('[sakaeSync] flush失敗:', k, e); return Promise.resolve(); }
    });
    await Promise.all(jobs);
  };

  // ---- localStorageへの書き込み・削除を乗っ取り、対象キーならSupabaseにも送る ----
  // （確定解除・残品表の削除などlocalStorage.removeItem()を使う操作も、ここでフックしないと
  //   Supabase側に古い値が残り続け、他の人の画面や次回読み込み時に元の状態へ巻き戻ってしまうため必須）
  function installLocalStorageHook(){
    const origSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value){
      origSetItem.apply(this, arguments);
      if(this === window.localStorage && isSyncKey(key) && !applyingRemoteUpdate){
        schedulePush(key, value);
      }
    };
    const origRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function(key){
      origRemoveItem.apply(this, arguments);
      if(this === window.localStorage && isSyncKey(key) && !applyingRemoteUpdate){
        scheduleDelete(key);
      }
    };
  }

  function schedulePush(key, value){
    if(pushTimers[key]) clearTimeout(pushTimers[key]);
    pendingActions[key] = ()=> pushKey(key, value);
    pushTimers[key] = setTimeout(()=> pushKey(key, value), PUSH_DEBOUNCE_MS);
  }

  function scheduleDelete(key){
    if(pushTimers[key]) clearTimeout(pushTimers[key]);
    pendingActions[key] = ()=> deleteKey(key);
    pushTimers[key] = setTimeout(()=> deleteKey(key), PUSH_DEBOUNCE_MS);
  }

  // ---- 自分が送った更新の控え（自己エコー除外用） ----
  // Supabaseのリアルタイム通知は「自分が送った変更」も自分に返してくる。
  // それを他の人からの更新と同じように取り込むと、送った直後に打った文字が
  // 送った時点の古い内容で上書きされ、入力が黙って消える。
  //
  // 「今のlocalStorageと届いた値が同じか」で見分ける方法は使えない。
  // 同期の受け側が先にlocalStorageを書き換えてしまうため、その時点で見分けがつかなくなるため。
  // そこで「自分がその内容を送ったかどうか」を控えておき、それが返ってきたときだけ捨てる。
  //
  // 他のタブ・他の人が送った更新は、こちらの控えに無いので従来どおり受け取る
  // （万一まったく同じ内容だった場合は、取り込んでも取り込まなくても結果が同じなので害はない）。
  const OUTBOX_TTL_MS = 120000;   // 往復が遅れても拾えるよう長めに持ち、古いものは捨てる
  const outbox = {};              // { [key]: [ { raw, at }, … ] }

  function rememberOutbound(key, raw){
    const now = Date.now();
    const list = (outbox[key] || []).filter(e=> now - e.at < OUTBOX_TTL_MS);
    list.push({ raw, at: now });
    outbox[key] = list;
  }
  function isOwnOutbound(key, raw){
    const now = Date.now();
    const list = (outbox[key] || []).filter(e=> now - e.at < OUTBOX_TTL_MS);
    outbox[key] = list;
    // 同じ内容が二度届くことがあるので、見つけても控えからは消さない（TTLで自然に落とす）
    return list.some(e=> e.raw === raw);
  }

  async function pushKey(key, value){
    delete pushTimers[key];
    delete pendingActions[key];
    let parsed;
    try{ parsed = JSON.parse(value); }catch(e){ parsed = value; } // 値がJSONでない場合も念のためそのまま送る
    // 送り出す前に控えておく。返ってきたときに自分のものだと分かるようにするため。
    // 控える形は、受け取り側が組み立てる形（row.value を JSON.stringify したもの）に揃える。
    try{ rememberOutbound(key, JSON.stringify(parsed)); }catch(e){}
    try{
      const { data:{ user } } = await sb.auth.getUser();
      await sb.from('kv_store').upsert({ key, value: parsed, updated_by: user ? user.id : null }, { onConflict:'key' });
    }catch(e){
      console.warn('[sakaeSync] push失敗:', key, e);
    }
  }

  async function deleteKey(key){
    delete pushTimers[key];
    delete pendingActions[key];
    try{
      await sb.from('kv_store').delete().eq('key', key);
    }catch(e){
      console.warn('[sakaeSync] 削除の同期に失敗:', key, e);
    }
  }

  // ---- 「中身が同じかどうか」をキーの並び順に左右されずに判定するための正規化 ----
  // Supabaseの value は jsonb で、保存するとキーの並び順がPostgres側の規則（長さ→バイト順）へ
  // 並べ替えられて返ってくる。そのため「自分が保存した値がそのまま返ってきただけ」でも
  // 文字列としては別物になり、下の重複抑止をすり抜けて localStorage を書き直し、
  // 各ページの storage ハンドラを起動して画面を作り直してしまっていた。
  // （工程を追加した直後など、ローカルのキー順が jsonb 順と食い違うときに起きる）
  // ここではキーを再帰的に並べ替えてから比較し、「意味が同じなら何もしない」ようにする。
  function stableStringify(v){
    if(v === null || typeof v !== 'object') return JSON.stringify(v);
    if(Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    const keys = Object.keys(v).sort();
    return '{' + keys.map(k=> JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  function isSameJsonText(a, b){
    if(a === b) return true;
    if(a == null || b == null) return false;
    try{
      return stableStringify(JSON.parse(a)) === stableStringify(JSON.parse(b));
    }catch(e){
      return false; // 解析できないものは「違う」として扱い、従来どおり反映する（fail-safe）
    }
  }

  // ---- Supabase側の値をlocalStorageへ反映する（自分のpushを誘発しないようフラグを立てる） ----
  function applyRemoteRow(row){
    if(!row || !row.key) return;
    applyingRemoteUpdate = true;
    try{
      const raw = JSON.stringify(row.value);
      // ---- 自分が送った更新が返ってきただけなら、何もしない ----
      // これを取り込むと、送った後に打った文字が送った時点の内容で上書きされて消える。
      // 「今のlocalStorageと同じか」ではなく「自分が送ったものか」で見分ける（上の outbox 参照）。
      if(isOwnOutbound(row.key, raw)) return;
      const cur = localStorage.getItem(row.key);
      if(cur === raw) return; // 変化が無ければ何もしない（余計な再描画を避ける）
      if(isSameJsonText(cur, raw)) return; // キーの並び順が違うだけ＝中身は同じ。書き直さない
      localStorage.setItem(row.key, raw);
      // 同じタブ内では標準のstorageイベントは発火しない仕様なので、手動で発火させて
      // 各ページの「他タブでの変更をリアルタイムに反映する」既存の仕組みに乗せる
      try{
        window.dispatchEvent(new StorageEvent('storage', { key: row.key, newValue: raw, storageArea: localStorage }));
      }catch(e){
        // 古いブラウザ等でStorageEventのコンストラクタが使えない場合のフォールバック
        const ev = document.createEvent('Event');
        ev.initEvent('storage', false, false);
        ev.key = row.key; ev.newValue = raw; ev.storageArea = localStorage;
        window.dispatchEvent(ev);
      }
    }finally{
      applyingRemoteUpdate = false;
    }
  }

  // ---- 他の人がSupabase側でキーを削除した（確定解除・残品表の削除など）ときに、このブラウザのlocalStorageからも消す ----
  function applyRemoteDelete(key){
    if(!key) return;
    applyingRemoteUpdate = true;
    try{
      if(localStorage.getItem(key) === null) return; // 元々無ければ何もしない
      localStorage.removeItem(key);
      try{
        window.dispatchEvent(new StorageEvent('storage', { key, newValue: null, storageArea: localStorage }));
      }catch(e){
        const ev = document.createEvent('Event');
        ev.initEvent('storage', false, false);
        ev.key = key; ev.newValue = null; ev.storageArea = localStorage;
        window.dispatchEvent(ev);
      }
    }finally{
      applyingRemoteUpdate = false;
    }
  }

  // ---- 初回：Supabase側にある分は取り込み、Supabaseにまだ無い（＝このブラウザにしか無い）分は送る ----
  // 順序を必ず「墓標を取り込む → 墓標を確定 → それ以外を取り込む → 生きている社内No.を出す → 送る」にする。
  // 長い間つないでいなかった端末が、削除を知らないまま古い案件データを持って戻ってきても、
  // 先に墓標を読んでいれば「これは消された案件だ」と分かり、共有へ送り返さずに済む。
  async function initialSync(){
    const { data, error } = await sb.from('kv_store').select('key, value');
    if(error){ console.warn('[sakaeSync] 初回取得に失敗:', error); return; }
    const rows = data || [];
    const remoteKeys = new Set();
    rows.forEach(row=> remoteKeys.add(row.key));

    // ① 墓標を最初に取り込む
    rows.forEach(row=>{ if(isTombKey(row.key)) applyRemoteRow(row); });

    // ② いま効いている削除を確定する（①で取り込んだ分＋この端末に元からある分）。
    //    削除イベントがあり、同じ recordId ＋ deletionId の取消イベントが無いものだけが効いている。
    const tombRecordIds = new Set();
    {
      const ids = [];
      const undone = new Set();
      for(let i=0;i<localStorage.length;i++){
        const k = localStorage.key(i);
        if(!k) continue;
        if(k.indexOf(TOMB_UNDO_PREFIX) === 0){
          const p = splitEventKey(k, TOMB_UNDO_PREFIX);
          if(p) undone.add(p.recordId + '_' + p.deletionId);
        }else if(k.indexOf(TOMB_PREFIX) === 0){
          const p = splitEventKey(k, TOMB_PREFIX);
          if(!p) continue;
          ids.push({ recordId: p.recordId, deletionId: p.deletionId });
        }
      }
      ids.forEach(d=>{
        if(undone.has(d.recordId + '_' + d.deletionId)) return;
        tombRecordIds.add(d.recordId);
      });
    }

    // ②' この端末が持っている案件一覧を、共有の内容で上書きされる前に控えておく。
    //     ④で「この端末で作ったばかりの案件」を見分けるために使う。
    const localRecordsBefore = parseRecordList(localStorage.getItem(RECORDS_KEY));

    // ③ 墓標以外を取り込む（案件一覧から墓標のある案件を外すのは各ページ側の役目）
    //    案件一覧だけは、共有の内容で丸ごと上書きすると、つながっていない間に
    //    この端末で作った案件が消えてしまうため、併合してから取り込む。
    let merged = null;
    rows.forEach(row=>{
      if(isTombKey(row.key)) return;
      if(row.key === RECORDS_KEY){
        merged = mergeRecordsForInitialSync(parseRecordList(row.value), localRecordsBefore, tombRecordIds);
        applyRemoteRow({ key: RECORDS_KEY, value: merged.list });
        return;
      }
      applyRemoteRow(row);
    });
    // この端末だけにあった案件を足したときは、共有側にも合流させる
    // （足さないままだと、その案件は他の端末からいつまでも見えない）
    if(merged && merged.added > 0){
      pushKey(RECORDS_KEY, JSON.stringify(merged.list));
    }

    // ④ いま生きている案件が使っている社内No.を集める。
    //    共有側の案件一覧を正とし、そこに無いものはこの端末で作ったばかりの案件だけを足す。
    //    ・共有にも同じ id がある案件は、共有側の社内No.が正しい
    //      （社内No.を変えた直後は、つないでいなかった端末が古い社内No.を持っている）
    //    ・削除された案件は数えない
    const remoteRecordsRow = rows.filter(r=> r.key === RECORDS_KEY)[0];
    const remoteRecords = parseRecordList(remoteRecordsRow && remoteRecordsRow.value);
    const remoteRecordIds = new Set();
    const livingProductNos = new Set();
    remoteRecords.forEach(r=>{
      if(!r || !r.id) return;
      remoteRecordIds.add(r.id);
      if(r.productNo && !tombRecordIds.has(r.id)) livingProductNos.add(String(r.productNo));
    });
    localRecordsBefore.forEach(r=>{
      if(!r || !r.productNo) return;
      if(tombRecordIds.has(r.id)) return;      // 消された案件
      if(remoteRecordIds.has(r.id)) return;    // 共有にもある＝共有側の社内No.が正しい
      livingProductNos.add(String(r.productNo)); // この端末にしか無い＝作ったばかりの案件
    });

    // ⑤ 共有側にまだ無いものを送る。
    //    applyRemoteDelete でこの端末のキーを消すので、先に一覧を作ってから回す。
    const localKeys = [];
    for(let i=0;i<localStorage.length;i++) localKeys.push(localStorage.key(i));
    localKeys.forEach(key=>{
      if(!isSyncKey(key) || remoteKeys.has(key)) return;
      if(isTombKey(key)){
        // 削除イベントも取消イベントも必ず全員へ伝える。
        // つないでいなかった端末で起きた削除・取り消しを、確実に全員へ届けるため。
        // 古い削除イベントが後から届いても、取消イベントが残っているので再削除にはならない。
        pushKey(key, localStorage.getItem(key));
        return;
      }
      const productNo = productNoOfKey(key);
      if(productNo && !livingProductNos.has(productNo)){
        // この社内No.を使っている案件が、共有側にもこの端末にも1件も無い。
        // ＝案件が消えた（削除された／社内No.が変わった）あとに取り残されたデータ。
        // 送り返すと、持ち主のいない行が残品表や工程の日程表に出てしまうので、
        // 送らず、この端末からも消す。
        applyRemoteDelete(key);
        return;
      }
      pushKey(key, localStorage.getItem(key));
    });
  }

  // ---- 以後は他の人の更新をリアルタイムに受け取る ----
  function subscribeRealtime(){
    sb.channel('kv_store_changes')
      .on('postgres_changes', { event:'*', schema:'public', table:'kv_store' }, (payload)=>{
        if(payload.eventType === 'DELETE'){
          // 削除前の行のkeyはpayload.oldに入っている
          applyRemoteDelete(payload.old && payload.old.key);
          return;
        }
        applyRemoteRow(payload.new);
      })
      .subscribe();
  }

  async function boot(){
    try{
      await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js');
      sb = window.supabase.createClient(window.SAKAE_SUPABASE_URL, window.SAKAE_SUPABASE_ANON_KEY);

      const { data:{ session } } = await sb.auth.getSession();
      if(!session){
        location.href = LOGIN_PAGE + '?next=' + encodeURIComponent(location.pathname + location.search);
        return;
      }

      installLocalStorageHook();
      await initialSync();
      subscribeRealtime();
      hideGate();

      // セッションが切れた（ログアウトされた）タイミングでもログイン画面へ
      sb.auth.onAuthStateChange((event)=>{
        if(event === 'SIGNED_OUT') location.href = LOGIN_PAGE;
      });
      window.sakaeSupabase = sb; // 他のページ（ログアウトボタンなど）から使えるように公開
    }catch(e){
      console.error('[sakaeSync] 起動に失敗しました。従来通りローカルのみで動作します。', e);
      hideGate();
    }
  }

  boot();
})();
