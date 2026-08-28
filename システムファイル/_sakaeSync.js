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
  const TOMB_PREFIX = 'sakaeIS_deletedRecord_v1_';
  const TOMB_UNDO_PREFIX = 'sakaeIS_deletedRecordUndo_v1_';
  const RECORDS_KEY = 'sakaeIS_records_v1';
  // 案件（社内No.）ごとに作られるキーの一覧。SAKAE SEIKI-iS.html の productDataKeys() と同じ並び。
  // 「末尾が社内No.かどうか」で判定すると sakaeIS_ncGanttMock_bars_v1_<工程コード> のような
  // 案件と無関係のキーまで巻き込むため、必ずこの明示リストの前方一致で判定する。
  const PRODUCT_KEY_PREFIXES = [
    'sakaeIS_buhinhyoMock_v1_',
    'sakaeIS_kobetsuMock_memos_v1_',
    'sakaeIS_kobetsuMock_view_v1_',
    'sakaeIS_kobetsuMock_rowcounts_v1_',
    'sakaeIS_kobetsuMock_laneassign_v1_',
    'sakaeIS_kobetsuMock_legacybars_v1_',
    'sakaeIS_kobetsuMock_checks_v1_',
    'sakaeIS_kobetsuMock_checkNames_v1_',
    'sakaeIS_kobetsuMock_confirm_v1_',
    'sakaeIS_shikyuNouhinBoard_v2_'
  ];
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
  function productNoOfKey(key){
    for(let i=0;i<PRODUCT_KEY_PREFIXES.length;i++){
      const p = PRODUCT_KEY_PREFIXES[i];
      if(key.indexOf(p) === 0) return key.slice(p.length);
    }
    return '';
  }
  function parseRecordList(v){
    try{
      const a = (typeof v === 'string') ? JSON.parse(v) : v;
      return Array.isArray(a) ? a : [];
    }catch(e){ return []; }
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
    const tombProductNos = new Set();
    {
      const dels = [];
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
          let productNo = '';
          try{ const v = JSON.parse(localStorage.getItem(k)); if(v && v.productNo) productNo = String(v.productNo); }catch(e){}
          dels.push({ recordId: p.recordId, deletionId: p.deletionId, productNo: productNo });
        }
      }
      dels.forEach(d=>{
        if(undone.has(d.recordId + '_' + d.deletionId)) return;
        tombRecordIds.add(d.recordId);
        if(d.productNo) tombProductNos.add(d.productNo);
      });
    }

    // ③ 墓標以外を取り込む（案件一覧から墓標のある案件を外すのは各ページ側の役目）
    rows.forEach(row=>{ if(!isTombKey(row.key)) applyRemoteRow(row); });

    // ④ いま生きている案件が使っている社内No.を集める。
    //    共有側とこの端末の両方から集めるのは、この端末で作ったばかりでまだ共有に無い案件を守るため。
    //    社内No.が作り直されている場合は、その社内No.のデータを止めてはいけない。
    const livingProductNos = new Set();
    const remoteRecordsRow = rows.filter(r=> r.key === RECORDS_KEY)[0];
    parseRecordList(remoteRecordsRow && remoteRecordsRow.value)
      .concat(parseRecordList(localStorage.getItem(RECORDS_KEY)))
      .forEach(r=>{
        if(r && r.productNo && !tombRecordIds.has(r.id)) livingProductNos.add(String(r.productNo));
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
      if(productNo && tombProductNos.has(productNo) && !livingProductNos.has(productNo)){
        // 消された案件の古いデータ。送り返さず、この端末からも消す
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
