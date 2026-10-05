// ============================================================
// _sakaeLocalMerge.js  同一ブラウザ内の画面どうしの「取り込み」を安全にする共通層（G9-⑥ / STORAGE-LOOP-01 是正）
//
// 直した問題
//   ・一度でも保存した画面が「編集中」扱いのまま戻らず、別タブ・別端末の正常な更新を F5 まで取り込まなかった（G9-⑥）
//   ・「届いたら自分の状態で保存し直す」を別画面の書込みにも当てていたため、編集済みの 2 画面が
//     storage event で保存し直しを往復し続けた（STORAGE-LOOP-01・実機 17,627 件）
//
// 考え方（設計 v1.3）
//   P1  localStorage はこのブラウザの中での唯一の真実。画面は「受信をきっかけに保存し直す」ことをしない。
//   P2  届いた値は base（最後に共有と一致していた値）／mine（自分の画面の値）／incoming（届いた値）の 3 者を欄ごとに突き合わせて取り込む。
//       自分が触っていない欄は incoming、相手が触っていない欄は mine。両方が別の値へ変えた欄（same-field）は★自動で選ばない。
//   P3  base は「自分の保存が共有へ届いた」ことを証明できた時だけ進める（同期層の控えが消え、かつその時の localStorage が自分の書いた値）。
//   P4  same-field は sakaeLocal_fieldConflict_v1_<key>（同期対象外）へ退避し、再読込しても自分の値を復旧できる。解決が成立した時だけ消す。
//   P5  同期層（_sakaeSync.js）の判定・送受信・pending/conflict は変えない。ここは画面側の取り込みだけを扱う。
//
// このファイルは localStorage の読み書きを「控え退避（sakaeLocal_fieldConflict_v1_）」以外では行わない。
// 保存は必ず各画面の既存の保存関数（save / saveBuhinState / saveRecords）を通す。
// ============================================================
(function(){
  'use strict';

  const CONFLICT_STORE_PREFIX = 'sakaeLocal_fieldConflict_v1_';   // sakaeLocal_ ＝ 同期対象外・控え対象外
  const FAST_POLL_MS = 500, FAST_POLL_MAX = 60;                    // 保存後 30 秒は 500ms 間隔で「届いたか」を見る
  const SLOW_POLL_MS = 5000;                                       // その後は前面にいる間 5 秒間隔（背面では時間を保証しない）

  // ---------------- 意味比較 ----------------
  function stable(v){
    if(v === null || typeof v !== 'object') return JSON.stringify(v);
    if(Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k=> JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  function same(a, b){ return stable(a) === stable(b); }
  function clone(v){ return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function isObj(v){ return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isIdArray(v){ return Array.isArray(v) && v.length > 0 && v.every(x=> isObj(x) && x.id != null && x.id !== ''); }

  // ---------------- path ----------------
  // 例 "order.itemName" / "parts[<partId>].processes[<procId>].date" / "records[<recordId>].customer"
  function segsOf(path){
    const out = [];
    String(path).split('.').forEach(part=>{
      const m = part.match(/^([^\[]*)(\[(.*)\])?$/);
      if(!m) return;
      if(m[1]) out.push({ key: m[1] });
      if(m[2] !== undefined) out.push({ id: m[3] });
    });
    return out;
  }
  function getPath(obj, path){
    let cur = obj;
    const segs = segsOf(path);
    for(let i=0;i<segs.length;i++){
      const s = segs[i];
      if(cur == null) return undefined;
      if(i === 0 && s.key !== undefined && Array.isArray(cur)) continue;   // 根が配列（案件一覧 records[]）のとき、先頭のラベル「records」は読み飛ばす（TOPFORM-01・BUG-3）
      if(s.key !== undefined) cur = cur[s.key];
      else cur = Array.isArray(cur) ? cur.find(x=> x && String(x.id) === String(s.id)) : undefined;
    }
    return cur;
  }
  function setPath(obj, path, value){
    let cur = obj;
    const segs = segsOf(path);
    for(let i=0;i<segs.length;i++){
      const s = segs[i], last = (i === segs.length - 1);
      if(i === 0 && s.key !== undefined && Array.isArray(cur) && !last) continue;   // 同上（BUG-3）
      if(s.key !== undefined){
        if(last){ if(value === undefined) delete cur[s.key]; else cur[s.key] = clone(value); return true; }
        if(cur[s.key] == null) return false;
        cur = cur[s.key];
      }else{
        if(!Array.isArray(cur)) return false;
        const idx = cur.findIndex(x=> x && String(x.id) === String(s.id));
        if(last){
          if(value === undefined){ if(idx >= 0) cur.splice(idx, 1); return true; }
          if(idx >= 0) cur[idx] = clone(value); else cur.push(clone(value));
          return true;
        }
        if(idx < 0) return false;
        cur = cur[idx];
      }
    }
    return false;
  }

  // ---------------- 3 者併合 ----------------
  // 戻り値 { merged, conflicts:[{ path, base, mine, incoming }] }
  //   merged の same-field 欄には mine が入る（画面には自分の値を残す）。base に置くべき形は guard 側で作る。
  function mergeLeaf(path, b, m, i, conflicts){
    if(same(m, b)) return clone(i);                 // 自分は触っていない → 相手
    if(same(i, b)) return clone(m);                 // 相手は触っていない → 自分
    if(same(i, m)) return clone(m);                 // 同じ値
    conflicts.push({ path: path, base: clone(b), mine: clone(m), incoming: clone(i) });
    return clone(m);                                // 自動で選ばない。表示は自分、保存は guard が incoming に差し替える
  }
  function mergeObject(prefix, b, m, i, conflicts){
    b = isObj(b) ? b : {}; m = isObj(m) ? m : {}; i = isObj(i) ? i : {};
    const out = {};
    const keys = Array.from(new Set([].concat(Object.keys(b), Object.keys(m), Object.keys(i)))).sort();
    keys.forEach(k=>{
      const p = prefix ? prefix + '.' + k : k;
      const v = mergeValue(p, b[k], m[k], i[k], conflicts);
      if(v !== undefined) out[k] = v;
    });
    return out;
  }
  function mergeValue(path, b, m, i, conflicts){
    const anyArr = [b, m, i].some(Array.isArray);
    if(anyArr){
      const idArr = [b, m, i].filter(Array.isArray).every(a=> a.length === 0 || isIdArray(a));
      if(idArr) return mergeIdArray(path, b || [], m || [], i || [], conflicts);
      return mergeLeaf(path, b, m, i, conflicts);   // id を持たない配列は 1 つの値として扱う
    }
    if(isObj(b) || isObj(m) || isObj(i)){
      if((m === undefined && i === undefined)) return undefined;
      return mergeObject(path, b, m, i, conflicts);
    }
    return mergeLeaf(path, b, m, i, conflicts);
  }
  // id で突き合わせる配列（parts / processes / records）
  //   ・削除は「一方が消し、他方が触っていない」時だけ。片方が消し片方が編集 → same-field（path は要素）
  //   ・並び順は決定論的（J-12）：base の順を骨格にし、新しい要素は「直前に居た要素（anchor）の後ろ」へ、
  //     同じ anchor に両側が足していれば先頭 id の小さい列から。どのタブで計算しても同じ順になる。
  function mergeIdArray(path, b, m, i, conflicts){
    const byId = (arr)=> { const o = {}; arr.forEach(x=>{ if(x && x.id != null) o[String(x.id)] = x; }); return o; };
    const B = byId(b), M = byId(m), I = byId(i);
    const ids = new Set([].concat(Object.keys(B), Object.keys(M), Object.keys(I)));
    const result = {};
    ids.forEach(id=>{
      const p = path + '[' + id + ']';
      const inB = id in B, inM = id in M, inI = id in I;
      if(inB && !inM && !inI){ return; }                                   // 両方が消した
      if(inB && !inM &&  inI){ if(same(I[id], B[id])) return;              // 自分が消し・相手は触っていない → 消す
                               conflicts.push({ path: p, base: clone(B[id]), mine: null, incoming: clone(I[id]) });
                               result[id] = clone(I[id]); return; }          // 自分が消し・相手が編集 → 自動で選ばない（表示は残す）
      if(inB &&  inM && !inI){ if(same(M[id], B[id])) return;              // 相手が消し・自分は触っていない → 消す
                               conflicts.push({ path: p, base: clone(B[id]), mine: clone(M[id]), incoming: null });
                               result[id] = clone(M[id]); return; }
      if(!inB && inM && !inI){ result[id] = clone(M[id]); return; }        // 自分が足した
      if(!inB && !inM && inI){ result[id] = clone(I[id]); return; }        // 相手が足した
      result[id] = mergeObject(p, B[id], M[id], I[id], conflicts);         // 両方にある → 欄ごと
    });
    // ---- 並び順（決定論） ----
    const order = [];
    const seen = new Set();
    const push = (id)=>{ if(result[id] && !seen.has(id)){ order.push(id); seen.add(id); } };
    const baseOrder = b.map(x=> String(x.id)).filter(id=> id in result);
    const mineBase = m.map(x=> String(x.id)).filter(id=> id in B), incBase = i.map(x=> String(x.id)).filter(id=> id in B);
    const bOrd = b.map(x=> String(x.id));
    const sameSeq = (x, y)=> x.length === y.length && x.every((v, k)=> v === y[k]);
    let skeleton = baseOrder;
    if(!sameSeq(mineBase, bOrd.filter(id=> mineBase.indexOf(id) >= 0)) && sameSeq(incBase, bOrd.filter(id=> incBase.indexOf(id) >= 0))) skeleton = mineBase.filter(id=> id in result);
    else if(!sameSeq(incBase, bOrd.filter(id=> incBase.indexOf(id) >= 0)) && sameSeq(mineBase, bOrd.filter(id=> mineBase.indexOf(id) >= 0))) skeleton = incBase.filter(id=> id in result);
    // 新規要素の「列」を anchor ごとに集める
    const runs = {};   // anchorId('' = 先頭) -> [ [id,id,...], ... ]
    [m, i].forEach(src=>{
      let anchor = '', run = null;
      src.forEach(x=>{
        const id = String(x.id);
        if(id in B){ anchor = id; run = null; return; }
        if(!(id in result)) return;
        if(!run){ run = []; (runs[anchor] = runs[anchor] || []).push(run); }
        if(run.indexOf(id) < 0) run.push(id);
      });
    });
    Object.keys(runs).forEach(a=> runs[a].sort((x, y)=> x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    (runs[''] || []).forEach(run=> run.forEach(push));
    skeleton.forEach(id=>{ push(id); (runs[id] || []).forEach(run=> run.forEach(push)); });
    Object.keys(result).sort().forEach(push);       // 念のため取りこぼしを id 順で
    return order.map(id=> result[id]);
  }
  function merge3(base, mine, incoming){
    const conflicts = [];
    const merged = mergeValue('', base, mine, incoming, conflicts);
    return { merged: merged, conflicts: conflicts };
  }
  // 作業票データ（buhinhyo）専用の入口。records は通さない（下の mergeRecords を使う）
  function merge3Buhin(base, mine, incoming){
    return merge3(isObj(base) ? base : {}, isObj(mine) ? mine : {}, isObj(incoming) ? incoming : {});
  }
  // 案件一覧（records[]）専用：削除は墓標だけ（dropTombed は呼び出し側）。無い＝消えた とは解釈しない。
  //   incoming に無く mine にある案件（Publication Hold 中・未共有）は残す。両方にある案件だけ欄ごと。
  function mergeRecords(base, mine, incoming){
    const conflicts = [];
    const b = Array.isArray(base) ? base : [], m = Array.isArray(mine) ? mine : [], i = Array.isArray(incoming) ? incoming : [];
    const idsOf = (a)=> a.map(x=> x && x.id != null ? String(x.id) : null).filter(Boolean);
    // 「無い」を削除と解釈しないため、削除判定が要る要素は base から外して merge へ渡す（＝新規扱いで残る）
    const mIds = new Set(idsOf(m)), iIds = new Set(idsOf(i));
    const bKeep = b.filter(x=> x && x.id != null && mIds.has(String(x.id)) && iIds.has(String(x.id)));
    const merged = mergeIdArray('records', bKeep, m, i, conflicts);
    return { merged: merged, conflicts: conflicts };
  }

  // ---------------- same-field の退避（同期対象外キー） ----------------
  const conflictStore = {
    key: function(syncKey){ return CONFLICT_STORE_PREFIX + syncKey; },
    read: function(syncKey){
      try{ const raw = localStorage.getItem(CONFLICT_STORE_PREFIX + syncKey); if(!raw) return null;
           const o = JSON.parse(raw); return (o && o.version === 1 && Array.isArray(o.entries)) ? o : null; }
      catch(e){ return null; }
    },
    write: function(syncKey, rec){
      try{
        if(!rec || !rec.entries || !rec.entries.length){ localStorage.removeItem(CONFLICT_STORE_PREFIX + syncKey); return; }
        localStorage.setItem(CONFLICT_STORE_PREFIX + syncKey, JSON.stringify(rec));
      }catch(e){}
    },
    remove: function(syncKey){ try{ localStorage.removeItem(CONFLICT_STORE_PREFIX + syncKey); }catch(e){} }
  };

  // ---------------- 差分の欄（leaf path）一覧 ----------------
  function diffPaths(a, b){
    const out = [];
    (function walk(path, x, y){
      if(same(x, y)) return;
      const arrs = [x, y].filter(Array.isArray);
      if(arrs.length && arrs.every(v=> v.length === 0 || isIdArray(v))){
        const X = {}, Y = {};
        (x || []).forEach(v=>{ X[String(v.id)] = v; }); (y || []).forEach(v=>{ Y[String(v.id)] = v; });
        new Set([].concat(Object.keys(X), Object.keys(Y))).forEach(id=>{
          const p = path + '[' + id + ']';
          if(!(id in X) || !(id in Y)) out.push(p); else walk(p, X[id], Y[id]);
        });
        return;
      }
      if(isObj(x) || isObj(y)){
        if(!isObj(x) || !isObj(y)){ out.push(path); return; }
        new Set([].concat(Object.keys(x), Object.keys(y))).forEach(k=> walk(path ? path + '.' + k : k, x[k], y[k]));
        return;
      }
      out.push(path);
    })('', a, b);
    return out;
  }

  // ---------------- 欄名（通知用） ----------------
  const LABELS = { 'order.customer':'客先名', 'order.model':'型式', 'order.itemName':'品名', 'order.qty':'数量', 'order.orderNo':'社内No.',
                   'order.orderDate':'受注日', 'order.dueDate':'納期', 'order.issueDate':'発行日', 'order.shipDate':'発送日',
                   'name':'部品名', 'code':'工程記号', 'date':'工程日付', 'days':'日数', 'hours':'工数', 'note':'メモ', 'ampm':'午前/午後',
                   'customer':'客先名', 'modelName':'型式', 'itemName':'品名', 'qty':'数量', 'status':'状態', 'dueDate':'納期' };
  function labelOf(path){
    if(LABELS[path]) return LABELS[path];
    const last = String(path).split('.').pop().replace(/\[.*\]$/, '');
    const ctx = /processes\[/.test(path) ? '工程の' : /parts\[/.test(path) ? '部品の' : /records\[/.test(path) ? '案件の' : '';
    return ctx + (LABELS[last] || last || path);
  }
  function short(v){ if(v === null || v === undefined) return '（なし）'; const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 24 ? s.slice(0, 24) + '…' : s; }

  // ---------------- 画面ごとの取り込み係（guard） ----------------
  // opts: { page, syncKey(), getMem(), setMem(obj), parse(raw), save(), render(), isProtected(), merge(base,mine,incoming) }
  function createGuard(opts){
    const g = {
      base: null,            // 共有の基準（settle の証明で進める。J-10：控えがあれば pending.base から復元）
      prevLastWrite: null,   // lastWrite の 1 つ前（同一ミリ秒の別タブ書込みと交錯したことを見分けるため：§race）
      lastWrite: null,       // ★突き合わせの基準＝この画面（またはこのブラウザ）が最後に保存先へ書いた値。
                             //   保存先はブラウザ内の唯一の真実なので、別画面の書込みは必ずこの値の上に積まれる。
                             //   これを base にすると「自分の未保存の変更」と「相手の変更」だけが差分になり、二重に問い合わせない
      ownWrite: null,        // { text, at, observed } 直近の自分の保存
      pendingIncoming: false,
      entries: [],           // same-field の退避（メモリ上の写し。正本は conflictStore）
      recentEdits: [],       // 直近の自分の編集 [{ path, value, at }]（相手の値に置き換わった時に「元に戻す」を出すため）
      infos: [],             // 情報通知（相手の値に更新された欄）[{ path, mine, incoming }]
      stats: { checkSettled: 0, adopt: 0, saves: 0, storageEvents: 0 },
      fastLeft: 0, fastTimer: null, slowTimer: null,
      pageId: null
    };
    try{ window.__sakaeGuards = (window.__sakaeGuards || []).concat([g]); }catch(e){}
    try{ g.pageId = sessionStorage.getItem('sakaeLocal_pageId') || (Math.random().toString(36).slice(2, 10)); sessionStorage.setItem('sakaeLocal_pageId', g.pageId); }catch(e){ g.pageId = 'p'; }
    const key = ()=> opts.syncKey();
    const readLS = ()=> { try{ const k = key(); return k ? localStorage.getItem(k) : null; }catch(e){ return null; } };
    const parse = (raw)=> { try{ const o = raw == null ? null : opts.parse(raw); return (g.causal && o && typeof o === 'object' && !Array.isArray(o) && o._sync !== undefined) ? (delete o._sync, o) : o; }catch(e){ return null; } };   // 因果画面：業務内容だけを扱う（_sync は目印）
    const readPending = ()=> { try{ return (window.sakaeSyncRead && window.sakaeSyncRead.getPending) ? window.sakaeSyncRead.getPending(key()) : null; }catch(e){ return null; } };

    // ============================================================
    // 因果同期（SYNC-RACE-01 CAUSAL BASE・opts.causal の画面＝作業票データ）
    //   相手の保存が「何を見て作られたか」（_sync.parent）を、自分が見た書込みの環 R から引いて merge3 の base にする。
    //   値が似ているかで推測しない。parent を証明できない相手の保存は、自分が書いた欄だけ選ばせる（fail-closed）。
    //   R は base の証拠であってデータの復元元ではない（消えた要素を R の写しから戻すことはしない）。
    // ============================================================
    g.causal = !!opts.causal;
    g.R = [];                      // 見た書込み {mid, parent, product(生の内容・_sync 無し), at, src:'init'|'own'|'event', legacy}
    g.lastWriteId = null;          // lastWrite の identity
    g.degraded = false;            // この key の因果記録が信用できない（UNKNOWN は全差分を選ばせる）＝ degradedReasons が空でない
    g.degradedReasons = [];        // ★CAUSALRING-01：DEGRADED の理由（固定順）。解除は理由ごとの証拠がそろった時だけ（設計 v1.3.1 §9・§21.6・§22）
    g.warnings = [];               // 画面に出す診断（因果同期が使えない・記録を保存できない）
    g.stats.invalid = { version: 0, mid: 0, parent: 0, shape: 0, parse: 0, persisted: 0 };
    g.stats.skip = 0; g.stats.known = 0; g.stats.unknown = 0; g.stats.persistFail = 0;
    g.stats.ringRetry = 0; g.stats.ringContention = 0; g.stats.heal = 0; g.stats.healCapHit = 0; g.stats.sameIdMismatch = 0;
    g.stats.qHeal = 0; g.stats.qHealCapHit = 0; g.stats.qRetry = 0; g.stats.quarantineOverflow = 0; g.stats.quarantineBroken = 0;
    // ★共有隔離（設計 v1.3 §21・v1.3.1 §22）：隔離はタブ間で共有する専用キーに置く。メモリは写し（qItems）と、そこから決まる有効な mid（quarantine）
    g.qItems = new Map();          // mid → { mid, detectedAt, reason, payloadHashes[] }（業務データ本文は持たない）
    g.quarantine = [];             // いま有効な隔離 mid（qItems から TTL で決まる）。リング・メモリ R・rAdd で使わない
    g.qBrokenSince = null;         // 隔離キーの破損を最初に検出した時刻（min・24h で失効）
    g.qBrokenEver = false;         // このページで隔離キーの破損を見たか（broken の解除条件を強くする）
    g.lastSeenInRingAt = {};       // 隔離 mid をリング上で最後に見かけた時刻（他タブからの再投入の観測）
    g.qKnown = new Set();          // このページが既に受け止めた隔離 mid（新しく知った時だけ mismatch を設定する＝§21.5）
    g.mismatchLog = [];            // 診断（mid 先頭 8 桁・経路・中身の canon の SHA-256 先頭 16 桁・時刻。業務データそのものは残さない）
    g.healLog = [];                // 診断（自己修復の時刻と結果）
    g.healTimes = []; g.qHealTimes = [];
    // ★v1.4.1 latest-own（§23.2・§24）：このページが正式に保存した最後の own。メモリと sessionStorage marker（タブごと）だけ
    g.lastOwnMid = null; g.lastOwnAt = 0;
    g.markerBroken = false;        // 起動時に marker が壊れていた（次の正式保存＋read-back まで missing を外さない）
    g.capRecoveryTimer = null; g.capRecoveryUsed = false;   // 上限到達後の bounded recovery（contention の 1 エピソードにつき 1 回）
    g.stats.capRecovery = 0; g.stats.healSkipSemantic = 0; g.stats.ringWriteSkipped = 0; g.stats.freshReadRetry = 0;
    // ★v1.4.3 pending incoming（§26）：受け手は取込み時にリングを書かない。届いた版の mid を、書き手の own がリングに見えるまで（上限 G）ページ内メモリで待つ
    g.pendingRing = new Map();     // mid → { receivedAt, deadline }（業務データ本文は持たない）
    g.pendingTimer = null;         // 常に 1 本（最も早い deadline）
    g.pendingOverflowActive = false;
    g.ownParentKeep = null;        // 自分の保存（rPersist(true)）の間だけ：その保存の parent は pending でも含める（§26.7）
    g.pendingLog = [];             // 診断（時刻・結果・件数。mid は先頭 8 桁）
    ['pendingAdded', 'pendingResolvedAtAdd', 'pendingResolvedOwn', 'pendingResolvedEvent', 'pendingEarly', 'pendingFallback', 'pendingDropped', 'pendingOverflow',
     'pendingHideResolved', 'pendingHideUnresolved', 'pendingOwnParent', 'pendingTimerArmed'].forEach(n=>{ g.stats[n] = 0; });
    const R_MEM_MAX = 16, R_PERSIST_MAX = 6, R_TTL_MS = 24 * 3600 * 1000, R_INDEX_MAX_KEYS = 20, R_PERSIST_BYTES = 512 * 1024;
    const OWN_RESERVE = 3, HEAL_WINDOW_MS = 10000, HEAL_MAX = 3;   // 自 write は最大 3 件を優先／自己修復は 10 秒に 3 回まで（安全弁）
    const Q_MAX = 64, Q_HASH_MAX = 4, Q_REASON = 'SAME_ID_PAYLOAD_MISMATCH', QUIET_MS = 10000;   // 隔離：正常保持の上限 64（超過は overflow・捨てない）／静穏観測 10 秒
    const REASON_ORDER = ['persist', 'broken', 'mismatch', 'overflow', 'marker', 'contention', 'missing', 'index'];
    const SEEN_PREFIX = 'sakaeLocal_seen_v1_', SEEN_INDEX = 'sakaeLocal_seenIndex_v1', QUAR_PREFIX = 'sakaeLocal_quarantine_v1_';   // sakaeLocal_ ＝ 同期対象外・控え対象外
    const causalLib = ()=> window.sakaeCausal || null;
    const stripSync = (o)=>{ if(o && typeof o === 'object' && !Array.isArray(o) && o._sync !== undefined) delete o._sync; return o; };
    // 画面のメモリ（state）は読み込み時の _sync を持ち得る。guard の比較は業務内容だけで行う
    const getMem = ()=>{ const m = opts.getMem(); return g.causal ? stripSync(m) : m; };
    const rawContentOf = (raw)=>{ const C = causalLib(); try{ return C ? C.contentOf(JSON.parse(raw)) : JSON.parse(raw); }catch(e){ return null; } };
    const productOfEntry = (e)=> parse(JSON.stringify(e.product));   // 環の写し（生）→ 画面の形（migrate 済み・_sync 無し）
    function rFind(mid){ return mid ? g.R.find(e=> e.mid === mid) : null; }

    // ---- CAUSALRING-01 の部品 ----
    //   ・TTL は実時間基準：1 回の処理の始めに referenceNow を 1 回だけ取り、referenceNow − at ≥ 24h を期限切れとする（比較はこの 1 か所）
    //   ・並び順は at 降順・同じ at は mid 昇順（mid は一意＝全順序）。referenceNow は並び順に使わない
    const expired = (at, referenceNow)=> (referenceNow - (at || 0)) >= R_TTL_MS;
    const byNewest = (a, b)=> ((b.at || 0) - (a.at || 0)) || (a.mid < b.mid ? -1 : (a.mid > b.mid ? 1 : 0));
    const byOldest = (a, b)=> ((a.at || 0) - (b.at || 0)) || (a.mid < b.mid ? -1 : (a.mid > b.mid ? 1 : 0));
    const strAsc = (a, b)=> (a < b ? -1 : (a > b ? 1 : 0));
    const payloadOf = (C, parent, product)=> (parent == null ? '' : String(parent)) + '\n' + C.canon(product);   // 本来変わらない部分（parent と内容）
    const reasonsOfText = (t)=> String(t || '').split(',').map(x=> x.trim()).filter(x=> REASON_ORDER.indexOf(x) >= 0);
    const orderReasons = (arr)=> REASON_ORDER.filter(r=> arr.indexOf(r) >= 0);
    const isQuarantined = (mid)=> g.quarantine.indexOf(mid) >= 0;
    const PENDING_GRACE_MS = 250, PENDING_MAX = 16, PENDING_BATCH_MS = 50;   // §26.4：G は coalescing window（正しさの根拠にしない）／§26.6：通常上限・期限が 50 ms 以内に並ぶ版は 1 回にまとめる
    // リングへ書く時のメモリ側：pending 中の mid は入れない（書き手の own が見える前に event で書かない）。自分の保存の parent だけは含める
    const ringMem = (ownWrite)=>{
      if(!g.pendingRing.size) return g.R;
      const keep = ownWrite ? g.ownParentKeep : null;
      return g.R.filter(e=> !g.pendingRing.has(e.mid) || e.mid === keep);
    };
    // メモリ R の上限（R_MEM_MAX）：古い順に捨てる。ただし確認待ち（pending）の版は件数都合で捨てない（§26.6・裁定 3）。
    //   いま足した版（keepMid：届いた最新版・自分の保存）も捨てない。pending が多い間だけ R は上限を一時的に超えうる（pending 自体は PENDING_OVERFLOW と期限で有限）
    function trimR(keepMid){
      if(g.R.length <= R_MEM_MAX) return;
      g.R.sort(byOldest);
      let over = g.R.length - R_MEM_MAX;
      g.R = g.R.filter(e=>{ if(over > 0 && !g.pendingRing.has(e.mid) && e.mid !== keepMid){ over--; return false; } return true; });
    }
    function pushPendingLog(x){ g.pendingLog.push(x); if(g.pendingLog.length > 20) g.pendingLog.splice(0, g.pendingLog.length - 20); }
    // ---- v1.4.1 latest-own marker（sessionStorage・§24.1）----
    const LASTOWN_PREFIX = 'sakaeLocal_lastOwn_v1_';
    const markerKey = ()=> LASTOWN_PREFIX + key() + '_' + String(opts.page || '');
    function writeMarker(mid, at){ try{ sessionStorage.setItem(markerKey(), JSON.stringify({ v: 1, mid: mid, at: at })); }catch(e){} }   // 書けない環境ではメモリだけ（§24.2-5）
    function readMarker(){
      let raw = null; try{ raw = sessionStorage.getItem(markerKey()); }catch(e){ return { none: true }; }
      if(raw == null) return { none: true };
      let o; try{ o = JSON.parse(raw); }catch(e){ return { broken: true }; }
      if(!o || typeof o !== 'object' || o.v !== 1 || typeof o.mid !== 'string' || !/^[0-9a-f]{64}$/.test(o.mid) || !Number.isFinite(o.at)) return { broken: true };
      return { mid: o.mid, at: o.at };
    }
    // V8（latest-own invariant）：このページの最新の自 write がリングに own で残っている。
    //   リングに無い時は「正規形の規則で正規に押し出された」ことを示せた場合だけ成立：
    //   メモリに自分の entry があれば、それをリングに足して正規形を作り直し、それでも選ばれないこと（より新しい own が優先枠を占めた等）。
    //   メモリに無い（再読込直後など）時は、より新しい own が優先枠（OWN_RESERVE＝3）を占めていること。示せなければ不成立（安全側）
    function latestOwnOk(entries, referenceNow, C){
      if(!g.lastOwnMid || expired(g.lastOwnAt, referenceNow)) return true;
      const list = entries || [];
      const e = list.find(x=> x.mid === g.lastOwnMid);
      if(e) return e.src === 'own';
      if(isQuarantined(g.lastOwnMid)) return true;   // 隔離された版（mismatch で DEGRADED 済み）は正規形に入らない
      const mine = g.R.find(x=> x.mid === g.lastOwnMid && x.src === 'own');
      if(mine && C){
        const u = unionEntries(C, [{ src: 'persisted', entries: list }, { src: 'memory', entries: [mine] }]);
        return !canonical(C, u.entries, referenceNow).entries.some(x=> x.mid === g.lastOwnMid);
      }
      const newerOwn = list.filter(x=> x.src === 'own' && x.mid !== g.lastOwnMid && (x.at || 0) > g.lastOwnAt).length;
      return newerOwn >= OWN_RESERVE;
    }
    // 意味キー（§23.5・§24.5）：正規形の並びのまま (mid, parent, src, legacy)。残った entry の at の値・updatedAt・直列化差は比べない。
    //   TTL と並びは正規形の計算（at を使う）で決めたうえで、その結果を比べる
    const semKey = (list)=> JSON.stringify((list || []).map(e=> [e.mid, e.parent == null ? null : e.parent, e.src === 'own' ? 'own' : 'event', !!e.legacy]));
    function setReason(reason){
      if(g.degradedReasons.indexOf(reason) < 0) g.degradedReasons = orderReasons(g.degradedReasons.concat([reason]));
      g.degraded = g.degradedReasons.length > 0;
    }
    // 永続 entry の検証（契約 C-03・現行の rLoad と同じ規則）。通らなければ null
    function validStoredEntry(C, e){
      if(!e || typeof e !== 'object' || !e.product || (e.parent !== null && !C.isHex64(e.parent))) return null;
      const info = C.identityOf(e.parent === null ? e.product : Object.assign({}, e.product, { _sync: { v: C.VERSION, parent: e.parent, mid: e.mid } }));
      if(info.state === 'INVALID' || info.identity !== e.mid) return null;
      return { mid: e.mid, parent: e.parent, product: info.content, at: Number(e.at) || 0, src: e.src === 'own' ? 'own' : 'event', legacy: !!e.legacy };
    }
    // 永続リングを読む：{ raw, broken（JSON として読めない）, entries（検証済み・保存順）, invalid（検証に落ちた数） }
    function readRing(C, k){
      let raw = null; try{ raw = localStorage.getItem(SEEN_PREFIX + k); }catch(e){ raw = null; }
      if(raw == null) return { raw: null, broken: false, entries: [], invalid: 0 };
      let o; try{ o = JSON.parse(raw); }catch(e){ return { raw: raw, broken: true, entries: [], invalid: 0 }; }
      if(!o || o.v !== 1 || !Array.isArray(o.entries)) return { raw: raw, broken: false, entries: [], invalid: 0 };
      const entries = []; let invalid = 0;
      o.entries.forEach(e=>{ let v = null; try{ v = validStoredEntry(C, e); }catch(x){ v = null; } if(v) entries.push(v); else invalid++; });
      return { raw: raw, broken: false, entries: entries, invalid: invalid };
    }
    // リング上に隔離 mid がいたら「見かけた時刻」を記録（他タブからの再投入の観測・§21.6-2）
    function noteSeenInRing(entries, referenceNow){ (entries || []).forEach(e=>{ if(isQuarantined(e.mid)) g.lastSeenInRingAt[e.mid] = referenceNow; }); }
    // 併合（§7.1）：mid ごとに「中身の種類」を集める。1 種類なら own は OR・at は max・legacy は OR。
    //   2 種類以上（同じ mid で parent／内容が違う）＝ SAME_ID_PAYLOAD_MISMATCH：経路に依らず、どちらも使わない。
    //   有効な隔離 mid は最初から使わない（§21.4-3）。判定は mid ごとの集合なので A→B／B→A で同一
    function unionEntries(C, lists){
      const byMid = new Map();
      lists.forEach(L=> (L.entries || []).forEach(e=>{
        if(!e || !e.mid) return;
        let slot = byMid.get(e.mid);
        if(!slot){ slot = { payloads: [], sources: [], own: false, at: 0, legacy: false, parent: e.parent, product: e.product }; byMid.set(e.mid, slot); }
        const p = payloadOf(C, e.parent, e.product);
        if(slot.payloads.indexOf(p) < 0) slot.payloads.push(p);
        if(slot.sources.indexOf(L.src) < 0) slot.sources.push(L.src);
        if(e.src === 'own') slot.own = true;
        if((e.at || 0) > slot.at) slot.at = e.at || 0;
        if(e.legacy) slot.legacy = true;
      }));
      const entries = [], mismatched = [];
      byMid.forEach((slot, mid)=>{
        if(isQuarantined(mid)){ mismatched.push({ mid: mid, sources: slot.sources, payloads: slot.payloads, known: true }); return; }
        if(slot.payloads.length > 1){ mismatched.push({ mid: mid, sources: slot.sources, payloads: slot.payloads, known: false }); return; }
        entries.push({ mid: mid, parent: slot.parent, product: slot.product, at: slot.at, src: slot.own ? 'own' : 'event', legacy: slot.legacy });
      });
      return { entries: entries, mismatched: mismatched };
    }
    function shortHash(C, s){ try{ return C.sha256hex(String(s)).slice(0, 16); }catch(e){ return ''; } }
    // 不一致の扱い（§21.5）：新しい不一致は隔離（メモリ）へ足し、呼び出し側が隔離キーをリングより先に書く。
    //   隔離済みの mid が現れた時は「再投入を見かけた」として記録し、mismatch を（解除されていれば）設定し直す
    function handleMismatches(C, list, referenceNow){
      (list || []).forEach(m=>{
        g.roundMismatch = true;   // この処理で不一致（または隔離 mid）を見た → 同じ回では mismatch を解除しない
        g.R = g.R.filter(e=> e.mid !== m.mid);
        if(m.known){
          g.lastSeenInRingAt[m.mid] = referenceNow;
          if(g.degradedReasons.indexOf('mismatch') < 0) markDegraded('mismatch', null);
          return;
        }
        const hashes = (m.payloads || []).map(p=> shortHash(C, p)).filter(h=> /^[0-9a-f]{16}$/.test(h));
        mergeQItem({ mid: m.mid, detectedAt: referenceNow, reason: Q_REASON, payloadHashes: hashes });
        g.qKnown.add(m.mid);
        g.qDirty = true;
        g.stats.sameIdMismatch++;
        g.mismatchLog.push({ mid: String(m.mid).slice(0, 8), sources: (m.sources || []).slice(0, 6), payloadHashes: hashes.slice().sort(strAsc).slice(0, Q_HASH_MAX), at: referenceNow });
        if(g.mismatchLog.length > 10) g.mismatchLog.splice(0, g.mismatchLog.length - 10);
        try{ console.warn('[sakaeLocalMerge] SAME_ID_PAYLOAD_MISMATCH（同じ記録 ID で中身が違うため、どちらも使いません）:', key(), String(m.mid).slice(0, 8), (m.sources || []).join(',')); }catch(x){}
        markDegraded('mismatch', null);
      });
      refreshQuarantine(referenceNow);
    }

    // ---- 共有隔離キー（§21・§22）----
    const isHex16 = (s)=> typeof s === 'string' && /^[0-9a-f]{16}$/.test(s);
    // 決定的な結合（§22.2）：detectedAt＝min・hash は和集合・reason は和集合（並べた先頭）
    function mergeQItem(it){
      const ex = g.qItems.get(it.mid);
      if(!ex){ g.qItems.set(it.mid, { mid: it.mid, detectedAt: it.detectedAt, reasons: [it.reason], payloadHashes: (it.payloadHashes || []).slice() }); return; }
      ex.detectedAt = Math.min(ex.detectedAt, it.detectedAt);
      if(ex.reasons.indexOf(it.reason) < 0) ex.reasons.push(it.reason);
      (it.payloadHashes || []).forEach(h=>{ if(ex.payloadHashes.indexOf(h) < 0) ex.payloadHashes.push(h); });
    }
    // 有効な隔離 mid を決める（TTL は実時間：referenceNow − detectedAt ≥ 24h で期限切れ。detectedAt は延長しない）
    function refreshQuarantine(referenceNow){
      const live = [];
      g.qItems.forEach((it, mid)=>{ if(expired(it.detectedAt, referenceNow)){ g.qItems.delete(mid); g.qKnown.delete(mid); } else live.push(mid); });
      g.quarantine = live.sort(strAsc);
      if(g.qBrokenSince != null && expired(g.qBrokenSince, referenceNow)) g.qBrokenSince = null;
      g.R = g.R.filter(e=> !isQuarantined(e.mid));
    }
    // 正規形（§22.2）：有効な Item を mid 昇順・各 Item は固定の項目順。件数では落とさない（64 超は overflow＝§22.1）
    function qCanonItems(){
      return g.quarantine.map(mid=>{
        const it = g.qItems.get(mid);
        return { mid: mid, detectedAt: it.detectedAt, reason: it.reasons.slice().sort(strAsc)[0], payloadHashes: it.payloadHashes.filter(isHex16).slice().sort(strAsc).slice(0, Q_HASH_MAX) };
      });
    }
    const qItemText = (it)=> '{"mid":' + JSON.stringify(it.mid) + ',"detectedAt":' + JSON.stringify(it.detectedAt) + ',"reason":' + JSON.stringify(it.reason) + ',"payloadHashes":' + JSON.stringify(it.payloadHashes) + '}';
    const qCoreText = (items, brokenSince)=> '"items":[' + items.map(qItemText).join(',') + '],"brokenSince":' + JSON.stringify(brokenSince == null ? null : brokenSince);
    // 隔離キーを読む：{ raw, broken, items（検証済み・保存順）, brokenSince }。形が少しでも壊れていたら broken（空集合扱いしない＝§22.3）
    function qRead(k){
      let raw = null; try{ raw = localStorage.getItem(QUAR_PREFIX + k); }catch(e){ raw = null; }
      if(raw == null) return { raw: null, broken: false, items: [], brokenSince: null };
      let o; try{ o = JSON.parse(raw); }catch(e){ return { raw: raw, broken: true, items: [], brokenSince: null }; }
      if(!o || typeof o !== 'object' || o.v !== 1 || !Array.isArray(o.items)) return { raw: raw, broken: true, items: [], brokenSince: null };
      const items = [];
      for(const it of o.items){
        if(!it || typeof it !== 'object' || typeof it.mid !== 'string' || !/^[0-9a-f]{64}$/.test(it.mid) || !Number.isFinite(it.detectedAt) || typeof it.reason !== 'string' || !Array.isArray(it.payloadHashes) || !it.payloadHashes.every(isHex16)) return { raw: raw, broken: true, items: [], brokenSince: null };
        items.push({ mid: it.mid, detectedAt: it.detectedAt, reason: it.reason, payloadHashes: it.payloadHashes.slice() });
      }
      const bs = (o.brokenSince == null) ? null : (Number.isFinite(o.brokenSince) ? o.brokenSince : NaN);
      if(Number.isNaN(bs)) return { raw: raw, broken: true, items: [], brokenSince: null };
      return { raw: raw, broken: false, items: items, brokenSince: bs };
    }
    // 隔離キーとメモリを併合し、違えば書く（§21.3）。read-back（QV1・QV2）・最大 2 回のやり直し。heal＝他タブの書込みを受けた自己修復（上限あり）
    //   戻り値 { ok, wrote, persistFailed, capped }
    function qSync(C, k, referenceNow, heal){
      let wrote = false;
      for(let attempt = 0; attempt < 3; attempt++){
        const st = qRead(k);
        if(st.broken){
          // 読めない＝隔離が失われたかもしれない：空集合扱いせず broken（fail-closed）。破損を最初に見た時刻を brokenSince に（min）
          g.qBrokenSince = (g.qBrokenSince == null) ? referenceNow : Math.min(g.qBrokenSince, referenceNow);
          g.qBrokenEver = true;
          if(attempt === 0) g.stats.quarantineBroken++;
        }
        st.items.forEach(mergeQItem);
        if(st.brokenSince != null) g.qBrokenSince = (g.qBrokenSince == null) ? st.brokenSince : Math.min(g.qBrokenSince, st.brokenSince);
        refreshQuarantine(referenceNow);
        if(g.qBrokenSince != null){ g.qBrokenEver = true; if(g.degradedReasons.indexOf('broken') < 0) markDegraded('broken', null); }
        if(g.quarantine.length > Q_MAX){
          if(g.degradedReasons.indexOf('overflow') < 0){ g.stats.quarantineOverflow++; try{ console.warn('[sakaeLocalMerge] 隔離が上限（' + Q_MAX + ' 件）を超えました。捨てずに保持し、保護を続けます:', k, g.quarantine.length); }catch(x){} markDegraded('overflow', null); }
        }
        const fresh = g.quarantine.filter(m=> !g.qKnown.has(m));   // 他タブの隔離を新しく知った → 受信タブも mismatch（保守側・§21.5）
        if(fresh.length){ fresh.forEach(m=> g.qKnown.add(m)); markDegraded('mismatch', null); }
        const items = qCanonItems();
        const want = qCoreText(items, g.qBrokenSince);
        const have = st.broken ? null : qCoreText(st.items, st.brokenSince);
        const empty = !items.length && g.qBrokenSince == null;
        if(want === have || (st.raw == null && empty)){ g.qDirty = false; return { ok: true, wrote: wrote, persistFailed: false, capped: false }; }
        if(heal){
          g.qHealTimes = g.qHealTimes.filter(t=> referenceNow - t < HEAL_WINDOW_MS);
          if(g.qHealTimes.length >= HEAL_MAX){
            g.stats.qHealCapHit++;
            pushHealLog({ at: referenceNow, result: 'q-cap' });
            const missingMine = items.some(it=> !st.items.some(x=> x.mid === it.mid));
            if(missingMine) markDegraded('contention', null);   // 上限到達は正常扱いにしない
            return { ok: false, wrote: wrote, persistFailed: false, capped: true };
          }
          g.qHealTimes.push(referenceNow); g.stats.qHeal++; pushHealLog({ at: referenceNow, result: 'q-heal' });
          heal = false;   // この呼出しで数えるのは 1 回だけ
        }
        try{ localStorage.setItem(QUAR_PREFIX + k, '{"v":1,' + want + ',"updatedAt":' + JSON.stringify(referenceNow) + '}'); wrote = true; }
        catch(e){ g.stats.persistFail++; markDegraded('persist', e); return { ok: false, wrote: wrote, persistFailed: true, capped: false }; }   // 古い隔離を削って成功扱いにはしない
        const back = qRead(k);
        const qv1 = !back.broken && items.every(it=> back.items.some(x=> x.mid === it.mid && x.detectedAt <= it.detectedAt));
        if(qv1){
          back.items.forEach(mergeQItem); if(back.brokenSince != null) g.qBrokenSince = (g.qBrokenSince == null) ? back.brokenSince : Math.min(g.qBrokenSince, back.brokenSince);
          refreshQuarantine(referenceNow);
          if(qCoreText(qCanonItems(), g.qBrokenSince) === qCoreText(back.items, back.brokenSince)){ g.qDirty = false; return { ok: true, wrote: true, persistFailed: false, capped: false }; }   // QV2
        }
        g.stats.qRetry++;
      }
      return { ok: false, wrote: wrote, persistFailed: false, capped: false };
    }

    // 直列化（正規形）：固定の項目順・内容は sakaeCausal.canon。同じ集合 → 同じ文字列
    function serializeEntry(C, e){
      return '{"mid":' + JSON.stringify(e.mid) + ',"parent":' + JSON.stringify(e.parent == null ? null : e.parent) + ',"product":' + C.canon(e.product)
        + ',"at":' + JSON.stringify(e.at || 0) + ',"src":' + JSON.stringify(e.src === 'own' ? 'own' : 'event') + ',"legacy":' + (e.legacy ? 'true' : 'false') + '}';
    }
    function serializeEntries(C, list){ return '[' + list.map(e=> serializeEntry(C, e)).join(',') + ']'; }
    const ringBody = (entriesText, referenceNow)=> '{"v":1,"entries":' + entriesText + ',"updatedAt":' + JSON.stringify(referenceNow) + '}';
    const overBytes = (entriesText)=> ('{"v":1,"entries":' + entriesText + ',"updatedAt":0000000000000}').length > R_PERSIST_BYTES;
    // 正規形（§7.2）：(U, referenceNow) の関数。最大 6 件＝自 write 最大 3 件 → 最新自 write の親 → 残りを新しい順。512K 文字超は 3 件
    function canonical(C, U, referenceNow){
      const live = U.filter(e=> !expired(e.at, referenceNow) && !isQuarantined(e.mid)).sort(byNewest);
      const own = live.filter(e=> e.src === 'own').slice(0, OWN_RESERVE);
      const parentOfNewestOwn = own.length ? (live.find(x=> x.mid === own[0].parent) || null) : null;
      const picked = own.slice();
      const has = (list, m)=> list.some(x=> x.mid === m);
      if(parentOfNewestOwn && !has(picked, parentOfNewestOwn.mid)) picked.push(parentOfNewestOwn);
      for(let i = 0; i < live.length && picked.length < R_PERSIST_MAX; i++){ if(!has(picked, live[i].mid)) picked.push(live[i]); }
      let sel = picked.slice().sort(byNewest);
      let text = serializeEntries(C, sel);
      if(overBytes(text)){
        const small = [];
        if(own[0]) small.push(own[0]);
        if(parentOfNewestOwn && !has(small, parentOfNewestOwn.mid)) small.push(parentOfNewestOwn);
        const rest = live.find(e=> !has(small, e.mid));
        if(rest) small.push(rest);
        sel = small.sort(byNewest); text = serializeEntries(C, sel);
      }
      return { entries: sel, entriesText: text, live: live };
    }
    // 併合結果をメモリ R にも取り込む（own は格下げしない・at は max・legacy は OR）。上限 R_MEM_MAX は現行どおり古い順に捨てる
    function absorb(list){
      list.forEach(e=>{
        if(isQuarantined(e.mid)) return;
        const ex = rFind(e.mid);
        if(ex){ if(e.src === 'own') ex.src = 'own'; if((e.at || 0) > (ex.at || 0)) ex.at = e.at; if(e.legacy) ex.legacy = true; }
        else g.R.push({ mid: e.mid, parent: e.parent, product: e.product, at: e.at, src: e.src === 'own' ? 'own' : 'event', legacy: !!e.legacy });
      });
      trimR();
    }

    // 環への登録：契約 C-03 の検証（v／mid 再計算／parent 形式／内容の形）に通ったものだけ。INVALID・隔離中は登録しない
    function rAdd(raw, src){
      const C = causalLib(); if(!C || raw == null) return null;
      let info; try{ info = C.identityOf(raw); }catch(e){ return null; }
      if(info.state === 'INVALID'){ (info.reasons || ['shape']).forEach(rs=>{ if(g.stats.invalid[rs] !== undefined) g.stats.invalid[rs]++; }); return null; }
      if(isQuarantined(info.identity)){ handleMismatches(C, [{ mid: info.identity, sources: ['incoming'], payloads: [], known: true }], Date.now()); return null; }
      const ex = rFind(info.identity);
      if(ex){
        // 同じ mid で中身が違う＝SAME_ID_PAYLOAD_MISMATCH（どちらも使わない・隔離キーへ）
        const pOld = payloadOf(C, ex.parent, ex.product), pNew = payloadOf(C, info.parent, info.content);
        if(pOld !== pNew){
          const referenceNow = Date.now();
          handleMismatches(C, [{ mid: info.identity, sources: ['memory', 'incoming'], payloads: [pOld, pNew], known: false }], referenceNow);
          const k = key(); if(k) qSync(C, k, referenceNow, false);
          return null;
        }
        ex.at = Math.max(ex.at || 0, Date.now()); if(src === 'own') ex.src = 'own'; if(info.state === 'LEGACY') ex.legacy = true;
        return ex;
      }
      const e = { mid: info.identity, parent: info.parent, product: info.content, at: Date.now(), src: src, legacy: info.state === 'LEGACY' };
      g.R.push(e);
      trimR(e.mid);
      return e;
    }
    // index：{ <key>: { lastOwnAt, ownCount, degraded, reason } }（形式は現行どおり）
    function rIndexRead(){ try{ const o = JSON.parse(localStorage.getItem(SEEN_INDEX) || 'null'); return (o && typeof o === 'object') ? o : {}; }catch(e){ return {}; } }
    function indexEntryOf(idx, k){ const e = idx && idx[k]; return (e && typeof e === 'object') ? e : null; }
    // 決定的な併合：lastOwnAt＝max・ownCount＝max・理由は和（removeReasons＝回復を確かめた理由だけ外す）。キーは lastOwnAt 降順・同値はキー昇順で 20 件
    function buildIndex(idx0, k, removeReasons){
      const cur = indexEntryOf(idx0, k) || { lastOwnAt: 0, ownCount: 0, degraded: false, reason: '' };
      let reasons = orderReasons((cur.degraded ? (reasonsOfText(cur.reason).length ? reasonsOfText(cur.reason) : ['index']) : []).concat(g.degradedReasons));
      if(removeReasons && removeReasons.length) reasons = reasons.filter(r=> removeReasons.indexOf(r) < 0);
      const mine = { lastOwnAt: Math.max(cur.lastOwnAt || 0, g.selfLastOwnAt || 0), ownCount: Math.max(cur.ownCount || 0, g.selfOwnCount || 0), degraded: reasons.length > 0, reason: reasons.join(',') };
      const lo = (x)=> (indexEntryOf(idx0, x) && idx0[x].lastOwnAt) || 0;
      const keys = Object.keys(idx0).filter(x=> x !== k).sort((a, b)=> (lo(b) - lo(a)) || strAsc(a, b)).slice(0, R_INDEX_MAX_KEYS - 1);
      const next = {}; keys.forEach(x=>{ next[x] = idx0[x]; });
      next[k] = mine;
      return next;
    }
    // read-back で確かめる不変条件（§7.3 V1〜V6・§21.4 V7）
    function verifyReadBack(C, k, idx1, referenceNow, mem){
      const back = readRing(C, k);
      noteSeenInRing(back.entries, referenceNow);
      const V1 = !back.broken && back.invalid === 0;
      const u = unionEntries(C, [{ src: 'persisted', entries: back.entries }, { src: 'memory', entries: mem || g.R }]);   // ★v1.4.3：pending 中の mid は書かなかったので比べない
      const can = canonical(C, u.entries, referenceNow);
      const V2 = semKey(can.entries) === semKey(back.entries);   // 意味で比べる（at の値だけの差は同値）
      const pageOwn = g.R.some(e=> e.src === 'own' && !expired(e.at, referenceNow));
      const ownInRing = back.entries.some(e=> e.src === 'own' && !expired(e.at, referenceNow));
      const V3 = !pageOwn || ownInRing;
      const V4 = back.entries.length <= R_PERSIST_MAX;
      const ib = indexEntryOf(rIndexRead(), k), im = idx1[k];
      const V5 = !!ib && (ib.lastOwnAt || 0) >= (im.lastOwnAt || 0) && (ib.ownCount || 0) >= (im.ownCount || 0);
      const V6 = u.mismatched.filter(m=> !m.known).length === 0;
      const V7 = !back.entries.some(e=> isQuarantined(e.mid)) && !g.R.some(e=> isQuarantined(e.mid));
      const V8 = latestOwnOk(back.entries, referenceNow, C);   // ★v1.4.1：このページの最新の自 write が own で残っている
      return { ok: V1 && V2 && V3 && V4 && V5 && V6 && V7 && V8, V1: V1, V2: V2, V3: V3, V4: V4, V5: V5, V6: V6, V7: V7, V8: V8, ownInRing: ownInRing, pageOwn: pageOwn };
    }
    // 回復（§9.2・§21.6・§22）：理由ごとに、その理由を直した証拠がそろった時だけ外す。別原因の成功・時間の経過だけでは外さない
    function tryRecover(C, k, v, w){
      if(!g.degradedReasons.length || !w.q || !w.q.ok) return;   // 隔離キーの read-back（QV1・QV2）が成立した回だけ
      const referenceNow = w.referenceNow;
      const quiet = g.quarantine.every(mid=>{ const it = g.qItems.get(mid); const last = Math.max(it ? it.detectedAt : 0, g.lastSeenInRingAt[mid] || 0); return (referenceNow - last) >= QUIET_MS; });
      const strong = v.ok && v.ownInRing && w.wroteRing && !g.roundMismatch;   // 正規形の保存 → read-back → V1〜V7・自 write 保持・この回の新しい不一致 0
      const clear = [];
      g.degradedReasons.forEach(r=>{
        if(r === 'persist'){ if(w.wroteRing && v.V1 && v.V4 && v.V5) clear.push(r); }                                     // 同じキーの index とリングの setItem が完了＋read-back（隔離キーも QV 成立）
        else if(r === 'broken'){
          if(g.qBrokenSince != null) return;                                                                             // 隔離キーの破損から 24h 経つまでは外さない（§22.3）
          if(g.qBrokenEver){ if(strong) clear.push(r); }                                                                 // 隔離キー由来：24h 経過 AND 全条件
          else if(w.wroteRing && v.V1) clear.push(r);                                                                    // リング由来：書き直して読める（自 write が無ければ下で missing 相当へ）
        }
        else if(r === 'marker'){ if(w.wroteIdx && v.V5) clear.push(r); }                                                 // index を書けて読み直しが一致
        else if(r === 'mismatch'){ if(strong && quiet) clear.push(r); }                                                  // §21.6：隔離 mid がリング・R に無い（V7）＋静穏 10 秒（AND）＋全条件
        else if(r === 'overflow'){ if(g.quarantine.length <= Q_MAX && strong) clear.push(r); }                           // §22.1：有効 64 件以下に戻る AND 全条件
        else if(r === 'missing'){ if(strong && !g.markerBroken) clear.push(r); }                                       // marker 破損由来は次の正式保存まで外さない（§24.2-4）
        else if(r === 'contention'){ if(strong && !g.pendingOverflowActive) clear.push(r); }                            // ★v1.4.3：PENDING_OVERFLOW が解けるまで外さない
        else if(r === 'index'){ if(strong) clear.push(r); }
      });
      if(!clear.length) return;
      const toMissing = clear.indexOf('broken') >= 0 && !g.qBrokenEver && !v.ownInRing;
      g.degradedReasons = g.degradedReasons.filter(r=> clear.indexOf(r) < 0);
      if(toMissing) g.degradedReasons = orderReasons(g.degradedReasons.concat(['missing']));
      g.degraded = g.degradedReasons.length > 0;
      if(clear.indexOf('marker') >= 0){ try{ localStorage.removeItem('sakaeLocal_seenDegraded_v1'); }catch(x){} }
      if(clear.indexOf('contention') >= 0){ g.capRecoveryUsed = false; if(g.capRecoveryTimer){ clearTimeout(g.capRecoveryTimer); g.capRecoveryTimer = null; } }
      try{
        const idx0 = rIndexRead();
        localStorage.setItem(SEEN_INDEX, JSON.stringify(buildIndex(idx0, k, clear.filter(r=> !(toMissing && r === 'missing')))));
      }catch(e){ setReason('marker'); try{ localStorage.setItem('sakaeLocal_seenDegraded_v1', '1'); }catch(y){} }
      try{ console.info('[sakaeLocalMerge] causal: 回復を確認した理由を外しました', k, clear.join(','), '残り:', g.degradedReasons.join(',') || 'なし'); }catch(x){}
      if(!g.degraded){ g.warnings = g.warnings.filter(x=> x.code !== 'degraded'); renderNotice(); }
    }
    // 永続化（§7.3・§21.4）：referenceNow → 隔離キー → (P⊔R) から隔離を除く → 新しい不一致は隔離キーへ先に → 正規形のリング → read-back V1〜V7
    function rPersist(ownWrite){
      if(!g.causal) return false;
      const k = key(); if(!k) return false;
      const C = causalLib(); if(!C) return false;
      const referenceNow = Date.now();          // ★この処理の中の TTL 判定はすべてこの値
      g.roundMismatch = false;
      if(ownWrite){
        const cur = indexEntryOf(rIndexRead(), k);
        g.selfLastOwnAt = referenceNow;
        g.selfOwnCount = Math.max(g.selfOwnCount || 0, ((cur && cur.ownCount) || 0) + 1);
      }
      let q = qSync(C, k, referenceNow, false);
      if(q.persistFailed) return false;
      let lastV = null;
      for(let attempt = 0; attempt < 3; attempt++){
        const idx0 = rIndexRead();
        const stored = readRing(C, k);
        noteSeenInRing(stored.entries, referenceNow);
        const mem = ringMem(ownWrite);   // ★v1.4.3：pending 中の mid は入れない（書く直前の fresh read と正規形の併合は毎回作り直す＝own は OR）
        const u = unionEntries(C, [{ src: 'persisted', entries: stored.entries }, { src: 'memory', entries: mem }]);
        handleMismatches(C, u.mismatched, referenceNow);
        if(g.qDirty){ q = qSync(C, k, referenceNow, false); if(q.persistFailed) return false; }   // ★隔離キーをリングより先に
        const idx1 = buildIndex(idx0, k, null);
        const can = canonical(C, u.entries, referenceNow);
        absorb(can.live);
        const degradedNow = g.degradedReasons.length > 0;   // DEGRADED の回復は「実際に書けて読み直せた」ことでしか証明しない
        // 自分の保存は at も含めた正規形を書く。受け手（取込み・修復）は因果の意味が変わる時だけ書く（no-op 抑止・§23.6）
        const changed = ownWrite ? (can.entriesText !== serializeEntries(C, stored.entries)) : (semKey(can.entries) !== semKey(stored.entries));
        const needRing = degradedNow || stored.broken || stored.invalid > 0 || changed;
        const needIdx = degradedNow || stable(idx1) !== stable(idx0);
        let wroteRing = false, wroteIdx = false;
        if(!needRing && !needIdx && !ownWrite) g.stats.ringWriteSkipped++;
        if(needRing){
          // 書く直前の読み直し（fresh read）：読んでから他画面が書いていたら、その内容で併合し直す（窓を縮めるだけで正しさの根拠にはしない）
          let fresh = null; try{ fresh = localStorage.getItem(SEEN_PREFIX + k); }catch(e){ fresh = null; }
          if(fresh !== stored.raw){ g.stats.freshReadRetry++; continue; }
        }
        if(needRing || needIdx){
          try{
            if(needIdx){ localStorage.setItem(SEEN_INDEX, JSON.stringify(idx1)); wroteIdx = true; }       // index を先に（own 書込みの事実を残す）
            if(needRing){ localStorage.setItem(SEEN_PREFIX + k, ringBody(can.entriesText, referenceNow)); wroteRing = true; }
          }catch(e){
            g.stats.persistFail++;
            markDegraded('persist', e);
            return false;
          }
        }
        const v = verifyReadBack(C, k, idx1, referenceNow, mem);
        if(v.ok){ tryRecover(C, k, v, { wroteRing: wroteRing, wroteIdx: wroteIdx, q: q, referenceNow: referenceNow }); return true; }
        lastV = v;
        g.stats.ringRetry++;
      }
      g.stats.ringContention++;
      if(lastV && !lastV.V8) markDegraded('contention', null);   // ★v1.4.1：最新の自 write が own で残らない＝正常扱いしない
      try{ console.info('[sakaeLocalMerge] causal: 読み直しで正規形に収束しないため、自己修復に任せます', k); }catch(x){}
      return false;
    }
    function markDegraded(reason, e){
      const k = key();
      if(!g.degraded){ try{ console.warn('[sakaeLocalMerge] 同期の因果記録を保存できません（保護を強めます）:', k, reason, e && e.message); }catch(x){} }
      setReason(reason);
      if(!g.warnings.some(w=> w.code === 'degraded')) g.warnings.push({ code: 'degraded', text: '同期の因果記録を保存できません（この画面では、他の画面・端末の変更と重なった欄を自動で決めず、選んでいただきます）' });
      try{ localStorage.setItem(SEEN_INDEX, JSON.stringify(buildIndex(rIndexRead(), k, null))); }
      catch(x){ setReason('marker'); try{ localStorage.setItem('sakaeLocal_seenDegraded_v1', '1'); }catch(y){} }
      renderNotice();
    }
    // 起動時の復元：隔離キーを先に読み（§21.4）、永続 R を全件再検証（mid は product＋parent から再計算して照合）。不合格・隔離中は捨てる
    function rLoad(){
      const C = causalLib(); if(!C) return;
      const k = key(); if(!k) return;
      const referenceNow = Date.now();
      g.roundMismatch = false;
      qSync(C, k, referenceNow, false);
      const stored = readRing(C, k);
      g.stats.invalid.persisted += stored.invalid;
      noteSeenInRing(stored.entries, referenceNow);
      const u = unionEntries(C, [{ src: 'persisted', entries: stored.entries.filter(e=> !expired(e.at, referenceNow)) }]);
      let ownRestored = 0;
      u.entries.forEach(e=>{
        if(rFind(e.mid)) return;
        g.R.push({ mid: e.mid, parent: e.parent, product: e.product, at: e.at, src: e.src === 'own' ? 'own' : 'event', legacy: !!e.legacy });
        if(e.src === 'own') ownRestored++;
      });
      handleMismatches(C, u.mismatched, referenceNow);
      if(g.qDirty) qSync(C, k, referenceNow, false);
      // ★v1.4.1：同じタブの再読込なら sessionStorage marker から最新の自 write を復元して V8 を確かめる（§24.2）
      const mk = readMarker();
      if(mk.broken){ g.markerBroken = true; markDegraded('missing', null); }   // 壊れた marker を「無し＝正常」と決めつけない
      else if(!mk.none && !expired(mk.at, referenceNow)){
        g.lastOwnMid = mk.mid; g.lastOwnAt = mk.at;
        if(!latestOwnOk(stored.entries, referenceNow, C)) markDegraded(stored.entries.some(x=> x.mid === mk.mid) ? 'contention' : 'missing', null);
      }
      const idx = indexEntryOf(rIndexRead(), k);
      const recentOwn = !!(idx && (referenceNow - (idx.lastOwnAt || 0)) < R_TTL_MS && (idx.ownCount || 0) > 0);
      const hasPending = !!readPending();
      if(idx && idx.degraded){
        // DEGRADED_CARRIED：引き継いだ元の理由を集合へ戻す（元が分からなければ index）
        const rs = reasonsOfText(idx.reason).filter(r=> r !== 'index');
        if(rs.length){ rs.forEach(r=> setReason(r)); markDegraded(rs[0], null); } else markDegraded('index', null);
      }
      else if(recentOwn && ownRestored === 0 && !hasPending) markDegraded(stored.broken ? 'broken' : 'missing', null);
      try{ if(localStorage.getItem('sakaeLocal_seenDegraded_v1') === '1') markDegraded('marker', null); }catch(e){}
    }
    // 自己修復（§7.4・§21.3）：他の画面が永続リング／隔離キーを書いた時、正規形と違えば書き直す。
    //   上限 10 秒に 3 回（リングと隔離キーは別に数える）。上限に達したら書かない・正常扱いにしない
    function scheduleHeal(){ if(g.healScheduled) return; g.healScheduled = true; setTimeout(()=>{ g.healScheduled = false; healRing(); }, 0); }
    function scheduleQHeal(){ if(g.qHealScheduled) return; g.qHealScheduled = true; setTimeout(()=>{ g.qHealScheduled = false; healQuarantine(); }, 0); }
    function pushHealLog(x){ g.healLog.push(x); if(g.healLog.length > 10) g.healLog.splice(0, g.healLog.length - 10); }
    function healQuarantine(){
      const C = causalLib(); const k = key(); if(!g.causal || !C || !k) return;
      const referenceNow = Date.now();
      qSync(C, k, referenceNow, true);   // 受け取った隔離を併合・メモリ R から除く・自分の知る隔離が欠けていれば書き直す（上限あり）
      const cur = readRing(C, k);
      if(cur.entries.some(e=> isQuarantined(e.mid))){ noteSeenInRing(cur.entries, referenceNow); scheduleHeal(); }   // リングに隔離 mid が残っていれば除く
    }
    // ★v1.4.3 pending incoming（§26）
    //   addPending：届いた版の mid を待ち行列へ。fresh read で既にリングにあれば待たない（own は OR で併合され、意味が同じなら書かない）
    function addPending(mid){
      if(!g.causal || !mid || g.pendingRing.has(mid)) return;
      const C = causalLib(), k = key(); if(!C || !k) return;
      if(readRing(C, k).entries.some(x=> x.mid === mid)){ g.stats.pendingResolvedAtAdd++; return; }
      if(!rFind(mid) || isQuarantined(mid)) return;
      const now = Date.now();
      g.pendingRing.set(mid, { receivedAt: now, deadline: now + PENDING_GRACE_MS });
      g.stats.pendingAdded++;
      if(g.pendingRing.size > PENDING_MAX) pendingOverflow(now);
      armPendingTimer();
    }
    // 上限超過（§26.6・裁定 3）：件数都合で捨てない。fresh read で解ける分を解き、なお超えていれば PENDING_OVERFLOW＝DEGRADED（contention・自動決定しない）
    function pendingOverflow(now){
      evaluatePending('overflow');
      if(g.pendingRing.size > PENDING_MAX){
        g.stats.pendingOverflow++;
        g.pendingOverflowActive = true;
        pushPendingLog({ at: now, result: 'overflow', size: g.pendingRing.size });
        try{ console.warn('[sakaeLocalMerge] 受信した版の確認待ちが上限（' + PENDING_MAX + ' 件）を超えました。捨てずに保持し、保護を強めます:', key(), g.pendingRing.size); }catch(x){}
        markDegraded('contention', null);
      }
    }
    function armPendingTimer(){
      if(g.pendingTimer){ clearTimeout(g.pendingTimer); g.pendingTimer = null; }
      if(!g.pendingRing.size) return;
      // §26.6：最も早い期限から 50 ms 以内に期限が並ぶ版は、その中の最後の期限で 1 回の評価・1 回の書込みにまとめる（各版の待ちは G 以上 G＋50 ms 以下・それ以上は延ばさない）
      let min = Infinity; g.pendingRing.forEach(p=>{ if(p.deadline < min) min = p.deadline; });
      let at = min; g.pendingRing.forEach(p=>{ if(p.deadline <= min + PENDING_BATCH_MS && p.deadline > at) at = p.deadline; });
      g.stats.pendingTimerArmed++;
      g.pendingTimer = setTimeout(()=>{ g.pendingTimer = null; evaluatePending('deadline'); }, Math.max(0, at - Date.now()) + 1);
    }
    // 再評価：必ず fresh read。リングに在る（own／event）→ 待ち終了（書く情報なし）。
    //   期限到達で無い → fallback（event として記録・書き手側の V8 が own を守る §26.4）。'hide' では書かない（裁定 2）
    function evaluatePending(reason){
      if(!g.pendingRing.size) return;
      const C = causalLib(), k = key(); if(!g.causal || !C || !k) return;
      const now = Date.now();
      const cur = readRing(C, k);
      let resolved = 0, fallback = 0, unresolved = 0;
      Array.from(g.pendingRing.entries()).forEach(([mid, p])=>{
        const e = cur.entries.find(x=> x.mid === mid);
        if(e){
          g.pendingRing.delete(mid); resolved++;
          if(e.src === 'own') g.stats.pendingResolvedOwn++; else g.stats.pendingResolvedEvent++;
          if(reason === 'ring' && now < p.deadline) g.stats.pendingEarly++;
          if(reason === 'hide') g.stats.pendingHideResolved++;
          return;
        }
        if(!rFind(mid) || isQuarantined(mid)){ g.pendingRing.delete(mid); g.stats.pendingDropped++; return; }   // 記録する対象が無い（隔離・メモリから外れた）
        if(reason !== 'hide' && now >= p.deadline){ g.pendingRing.delete(mid); fallback++; g.stats.pendingFallback++; return; }
        unresolved++;
      });
      if(reason === 'hide'){ g.stats.pendingHideUnresolved += unresolved; return; }   // 閉じる直前でも stale な event を強制で書かない
      if(fallback) pushPendingLog({ at: now, result: 'fallback', n: fallback });
      if(g.pendingOverflowActive && g.pendingRing.size <= PENDING_MAX) g.pendingOverflowActive = false;
      if(resolved || fallback) rPersist(false);   // fresh read → 正規形（own は OR）→ 意味が違う時だけ書く
      armPendingTimer();
    }
    // 上限到達後の bounded recovery（§23.4・§24.4）：窓が明けたら 1 回だけ。正規形の保存 → read-back → V1〜V8 → 隔離キー が成立した時だけ contention を外す（tryRecover）。
    //   失敗したら DEGRADED を維持し、contention が外れるまで再び予約しない（無限 retry 禁止）
    function scheduleCapRecovery(referenceNow){
      if(g.capRecoveryTimer || g.capRecoveryUsed) return;
      const oldest = g.healTimes.length ? Math.min.apply(null, g.healTimes) : referenceNow;
      const wait = Math.max(0, HEAL_WINDOW_MS - (referenceNow - oldest)) + 50;
      g.capRecoveryTimer = setTimeout(()=>{
        g.capRecoveryTimer = null; g.capRecoveryUsed = true;
        const t = Date.now();
        g.stats.capRecovery++; g.healTimes.push(t); pushHealLog({ at: t, result: 'recovery' });
        rPersist(false);
      }, wait);
    }
    function healRing(){
      const C = causalLib(); const k = key(); if(!g.causal || !C || !k) return;
      const referenceNow = Date.now();
      g.roundMismatch = false;
      qSync(C, k, referenceNow, false);
      const cur = readRing(C, k);
      noteSeenInRing(cur.entries, referenceNow);
      const u = unionEntries(C, [{ src: 'persisted', entries: cur.entries }, { src: 'memory', entries: ringMem(false) }]);   // ★v1.4.3：pending 中の mid は修復で書かない
      handleMismatches(C, u.mismatched, referenceNow);
      if(g.qDirty) qSync(C, k, referenceNow, false);
      const can = canonical(C, u.entries, referenceNow);
      if(!cur.broken && cur.invalid === 0 && semKey(can.entries) === semKey(cur.entries)){   // 因果の意味が同じ＝修復しない（予算を使わない・§23.5）
        if(can.entriesText !== serializeEntries(C, cur.entries)) g.stats.healSkipSemantic++;
        if(!latestOwnOk(cur.entries, referenceNow, C)) markDegraded('contention', null);   // 書いても直らない欠落＝正常扱いしない
        return;
      }
      g.healTimes = g.healTimes.filter(t=> referenceNow - t < HEAL_WINDOW_MS);
      if(g.healTimes.length >= HEAL_MAX){
        g.stats.healCapHit++;
        pushHealLog({ at: referenceNow, result: 'cap' });
        if(!g.healWarnedAt || referenceNow - g.healWarnedAt >= HEAL_WINDOW_MS){ g.healWarnedAt = referenceNow; try{ console.warn('[sakaeLocalMerge] 因果記録の自己修復が上限（10 秒に 3 回）に達しました。修復を止め、保護を続けます:', k); }catch(x){} }
        // ★v1.4.1：上限到達を正常扱いにしない。読み直したリングで V8（このページの最新の自 write が own）を確かめ、欠けていれば即 contention（§23.3・§24.3）
        if(!latestOwnOk(cur.entries, referenceNow, C)){
          markDegraded('contention', null);
          scheduleCapRecovery(referenceNow);
        }
        return;
      }
      g.healTimes.push(referenceNow);
      g.stats.heal++;
      pushHealLog({ at: referenceNow, result: 'heal' });
      rPersist(false);
    }
    // 自分が書いた欄（ownPaths）：環の own entry と、その基にした写しとの差分の和 ＋ 控え（pending.base→local）の差分
    // 戻り値 [{ path, value }]：value ＝ その欄に自分（このブラウザ）が書いた値（own entry の内容／控えの local）
    function ownDeltaPaths(){
      const out = new Map();
      const leaves = (prefix, v, acc)=>{   // 要素の中の欄（入れ子の id 配列は要素ごと）
        if(isIdArray(v)){ v.forEach(x=>{ const p = prefix + '[' + x.id + ']'; acc.push({ path: p, value: clone(x), elementOnly: true }); leaves(p, x, acc); }); return; }
        if(isObj(v)){ Object.keys(v).forEach(k=> leaves(prefix ? prefix + '.' + k : k, v[k], acc)); return; }
        acc.push({ path: prefix, value: clone(v) });
      };
      const add = (paths, src)=> paths.forEach(p=>{
        if(out.has(p)) return;
        const v = getPath(src, p);
        if(/]$/.test(p) && isObj(v)){ out.set(p, { path: p, value: clone(v), elementOnly: true }); const acc = []; leaves(p, v, acc); acc.forEach(x=>{ if(!out.has(x.path)) out.set(x.path, x); }); return; }
        out.set(p, { path: p, value: clone(v) });
      });
      // 控え（このブラウザの未共有の最新の書込み）を先に＝同じ欄なら控えの値が「自分が書いた値」
      try{ const p = readPending(); if(p && p.base != null && p.local != null){ const loc = parse(p.local); add(diffPaths(parse(p.base), loc), loc); } }catch(x){}
      const referenceNow = Date.now();   // ★TTL は処理ごとに 1 回取った時刻と同じ比較式（CAUSALRING-01 設計 v1.2）
      g.R.filter(e=> e.src === 'own' && !expired(e.at, referenceNow)).sort(byNewest).forEach(e=>{
        const pe = rFind(e.parent);
        try{
          const mineObj = productOfEntry(e);
          if(pe) add(diffPaths(productOfEntry(pe), mineObj), mineObj);
          else { const acc = []; leaves('', mineObj, acc); acc.forEach(x=>{ if(x.path && !out.has(x.path)) out.set(x.path, x); }); }   // 基が分からない＝その書込みの全ての欄
        }catch(x){}
      });
      return Array.from(out.values());
    }
    // 相手の保存の base を因果で決める：{ mode:'known'|'unknown', base }
    //   base ＝ 自分の最後の書込み（lastWrite）の系譜と、相手の保存の系譜（_sync.parent を遡る）との最初の共通祖先（LCA）。
    //   ・相手が自分の最新を見た（parent=lastWrite）→ base=lastWrite
    //   ・相手が古い自分の書込みしか見ていない（stale）→ base=その古い書込み（自分がその後に変えた欄は保持）
    //   ・相手の方が新しい（自分が保護中で取り込んでいない書込みの上に相手が書いた）→ base=lastWrite（相手側の変更を全て採用・自分の未保存分は保持）
    //   共通祖先が環に無ければ UNKNOWN（推測しない）。
    function baseFor(raw){
      const C = causalLib();
      const unknown = (id)=> ({ mode: 'unknown', base: g.lastWrite || g.base, identity: id || null });
      if(!C) return unknown(null);
      let info; try{ info = C.identityOf(raw); }catch(e){ return unknown(null); }
      if(info.state !== 'VALID') return unknown(info.identity);
      const anc = new Set();
      let cur = g.lastWriteId, n = 0;
      while(cur && n++ < 64){ anc.add(cur); const e = rFind(cur); if(!e) break; cur = e.parent; }
      let mid = info.identity, m = 0;
      while(mid && m++ < 64){
        if(anc.has(mid)){ const e = rFind(mid); if(e) return { mode: 'known', base: productOfEntry(e), identity: info.identity }; break; }
        const e = rFind(mid);
        if(!e){ if(mid === info.identity){ mid = info.parent; continue; } break; }   // 届いた値そのものはまだ環に無くてもよい（parent から辿る）
        mid = e.parent;
      }
      return unknown(info.identity);
    }
    // 取り込みの併合（causal）：KNOWN＝因果 base で merge3／UNKNOWN＝守る欄を先に閉じてから残りを merge3
    function mergeIncoming(mem, incoming, raw){
      if(!g.causal) return { r: opts.merge(g.lastWrite || g.base, mem, incoming), mode: 'plain' };
      const bf = baseFor(raw);
      if(bf.mode === 'known'){ g.stats.known++; g.lastMerge = { mode: 'known' }; return { r: opts.merge(bf.base, mem, incoming), mode: 'known', identity: bf.identity }; }
      g.stats.unknown++;
      const lastWrite = g.lastWrite || g.base || {};
      const own = g.degraded ? null : ownDeltaPaths();
      // DEGRADED：自分と相手が違う欄は全部（自分の書いた値は分からないので mem を自分の値とする）
      const cand = own === null ? diffPaths(mem, incoming).map(p=> ({ path: p, value: getPath(mem, p) })) : own;
      const protect = [];
      // 守る欄＝自分が書いた欄で、相手の値が「いまの自分の値」とも「自分が書いた値」とも違うもの
      //（相手が自分の書いた値をそのまま持っているなら、それは自分の書込みを見た結果であり奪われていない）
      cand.forEach(c=>{
        const p = c.path, iv = getPath(incoming, p), mv = getPath(mem, p);
        if(c.elementOnly){ if(iv === undefined && mv !== undefined) protect.push(p); return; }   // 自分が足した要素が相手に無い → 削除と決めない
        if(!same(iv, mv) && !same(iv, c.value)) protect.push(p);
      });
      // 要素そのものを守る時は、その中の欄は個別に守らない（要素ごと conflict にする）
      const elementProtected = protect.filter(p=> /]$/.test(p));
      for(let i = protect.length - 1; i >= 0; i--){ if(elementProtected.some(ep=> protect[i] !== ep && protect[i].indexOf(ep) === 0)) protect.splice(i, 1); }
      // protect の欄は併合に渡さない（3 者とも lastWrite の値に揃えて無変化にする）→ 併合後に自分の値を戻す
      const mineP = clone(mem), incP = clone(incoming);
      protect.forEach(p=>{ const lv = getPath(lastWrite, p); setPath(mineP, p, lv); setPath(incP, p, lv); });
      const r = opts.merge(lastWrite, mineP, incP);
      g.lastMerge = { mode: 'unknown', degraded: g.degraded, cand: cand.map(c=> c.path), protect: protect.slice() };
      protect.forEach(p=>{
        const mv = getPath(mem, p), iv = getPath(incoming, p);
        setPath(r.merged, p, mv);
        r.conflicts.push({ path: p, base: clone(getPath(lastWrite, p)), mine: mv === undefined ? null : clone(mv), incoming: iv === undefined ? null : clone(iv), cause: 'unknown-parent' });
      });
      return { r: r, mode: 'unknown', identity: bf.identity };
    }

    // ---- 退避の読み書き ----
    function loadEntries(){ const rec = conflictStore.read(key()); g.entries = rec ? rec.entries.slice() : []; }
    function persistEntries(){
      conflictStore.write(key(), g.entries.length ? { version: 1, syncKey: key(), dataType: opts.dataType || '', recordId: opts.recordId || '', productNo: opts.productNo || '', entries: g.entries } : null);
    }
    function upsertEntries(conflicts){
      conflicts.forEach(c=>{
        const ex = g.entries.find(e=> e.path === c.path);
        if(ex){ ex.incoming = clone(c.incoming); }      // 相手がさらに変えた → incoming だけ更新。mine は保持
        else g.entries.push({ path: c.path, base: clone(c.base), mine: clone(c.mine), incoming: clone(c.incoming), detectedAt: new Date().toISOString(), pageId: g.pageId, byPage: opts.page || '', cause: c.cause || 'same-field' });
      });
    }
    // R-d：LS の欄が自分の値と一致していれば解決成立（両者一致）。相手がさらに変えていれば incoming を更新（J-11）。
    function reconcileEntriesWithLS(lsObj){
      if(!g.entries.length || !lsObj) return;
      g.entries = g.entries.filter(e=>{
        const cur = getPath(lsObj, e.path);
        if(same(cur, e.mine)) return false;              // 一致＝解決
        if(!same(cur, e.incoming)) e.incoming = clone(cur);
        return true;
      });
    }
    // 未解決の欄は「自分の値」を画面へ戻す（復旧）。★自分の値を持つのは、その重なりを起こした画面（byPage）だけ。
    //   相手側の画面（例：個別日程表）は選択 UI を出すが、相手の値を自分のメモリへは入れない。
    const ownEntries = ()=> g.entries.filter(e=> e.byPage === (opts.page || ''));
    function applyMineToMem(mem){
      ownEntries().forEach(e=>{ if(e.mine === null || e.mine === undefined) setPath(mem, e.path, undefined); else setPath(mem, e.path, e.mine); });
      return mem;
    }

    // ---- 初期化（J-10：控えがあれば base は pending.base から。settled 扱いしない）----
    g.init = function(){
      const raw = readLS();
      const lsObj = parse(raw);
      const p = readPending();
      if(p && raw != null && same(parse(p.local), lsObj) && p.base != null){
        g.base = parse(p.base) || {};
      }else if(p && raw != null && same(parse(p.local), lsObj) && p.base == null){
        g.base = Array.isArray(lsObj) ? [] : {};
      }else{
        g.base = clone(lsObj) || (Array.isArray(lsObj) ? [] : {});
      }
      g.lastWrite = clone(lsObj) || (Array.isArray(lsObj) ? [] : {});
      if(g.causal){
        if(!causalLib()){
          // 因果同期の共通実装が無い＝保存を受け付けない（旧 setItem へ戻さない）。明示的に知らせる
          g.warnings.push({ code: 'causalUnavailable', text: '因果同期の共通処理（sakaeCausal）が読み込めないため、この画面では保存できません。ページを再読み込みしてください。' });
          try{ console.warn('[sakaeLocalMerge] sakaeCausal が無いため保存を受け付けません:', key()); }catch(e){}
        }else{
          rLoad();
          const e0 = rAdd(raw, 'init');
          g.lastWriteId = e0 ? e0.mid : null;
        }
      }
      loadEntries();
      if(lsObj) reconcileEntriesWithLS(lsObj);
      if(g.entries.length){
        const mem = getMem();
        if(mem) applyMineToMem(mem);
        persistEntries();
      }
      startSlowPoll();
      ['focus', 'pageshow', 'online'].forEach(ev=> window.addEventListener(ev, onResume));
      window.addEventListener('pagehide', ()=>{ try{ evaluatePending('hide'); }catch(e){} });   // ★v1.4.3：最終 fresh read（補助・安全性の根拠にしない・書かない）
      document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState === 'visible') onResume(); });
      renderNotice();
    };
    function onResume(){
      // 操作を受ける前に：届いた自分の保存を証明して base を進め、保留があれば取り込む
      g.checkSettled();
      if(g.pendingIncoming && !opts.isProtected()) g.adopt();
    }

    // ---- 同じタブで唯一の入口（writeProductData）が書いたテキストを環へ登録（同じタブには storage event が来ない）----
    g.noteWrite = function(k, text){ if(!g.causal || k !== key() || text == null) return; rAdd(text, 'event'); };
    // ---- 保存直後（各画面の保存関数の末尾で呼ぶ）----
    g.noteOwnSave = function(savedText){
      if(savedText && typeof savedText === 'object'){
        // 因果同期：writeProductData の結果。書かなかった（skip／失敗）なら自分の書込みとして数えない
        if(savedText.ok === false) return;
        if(savedText.wrote === 'skip'){ g.stats.skip++; return; }
        savedText = (typeof savedText.text === 'string') ? savedText.text : null;
      }
      const text = (typeof savedText === 'string') ? savedText : (readLS() || '');
      if(g.causal){
        const e = rAdd(text, 'own');
        if(e){
          g.lastWriteId = e.mid;
          // ★v1.4.1：その画面自身の正式保存の時だけ latest-own と sessionStorage marker を更新（受信・取込み・修復・リング書換えでは更新しない）
          g.lastOwnMid = e.mid; g.lastOwnAt = Date.now(); writeMarker(g.lastOwnMid, g.lastOwnAt); g.markerBroken = false;
        }
        // ★v1.4.3：pending 中の自分の保存（§26.7）：先に fresh read で解ける分を解き、この保存の parent だけは pending でも含めて書く
        if(g.pendingRing.size) evaluatePending('own');
        g.ownParentKeep = (e && e.parent && g.pendingRing.has(e.parent)) ? e.parent : null;
        try{ rPersist(true); }
        finally{
          if(g.ownParentKeep){ g.pendingRing.delete(g.ownParentKeep); g.stats.pendingOwnParent++; armPendingTimer(); }
          g.ownParentKeep = null;
        }
      }
      const p = readPending();
      g.ownWrite = { text: text, at: Date.now(), observed: !!(p && same(parse(p.local), parse(text))) };
      const nowObj = parse(text);
      g.prevLastWrite = g.lastWrite;
      g.lastWrite = nowObj || g.lastWrite;
      g.stats.saves++;
      startFastPoll();
    };
    // ---- 保存に渡す値 ----
    // ★保存は常に「保存先の現在値との併合結果」にする。保護中（入力中・ドラッグ中）に別画面が書いた値を、
    //   自分の古いメモリで上書きして消さないため。併合結果はメモリにも入れる（描き直しは保護解除時＝IME を壊さない）。
    //   未解決の「同じ欄の重なり」は自分の値を流さず、保存先の現在値で書く（黙って共有へ流さない）。
    g.prepareSave = function(memObj){
      if(g.causal && !causalLib()){ if(!g.warnings.some(w=> w.code === 'causalUnavailable')) g.warnings.push({ code: 'causalUnavailable', text: '因果同期の共通処理（sakaeCausal）が読み込めないため、この画面では保存できません。ページを再読み込みしてください。' }); renderNotice(); return null; }
      if(g.causal) stripSync(memObj);
      const lsRaw = readLS();
      const lsObj = parse(lsRaw);
      // 直近の自分の編集＝メモリと最後の書込みの差（相手の値へ置き換わった時に「元に戻す」を出すため）
      // 欄（スカラー値）だけを覚える。部品・工程の追加／削除（要素そのもの）は「欄の入力」ではないので対象外
      try{ diffPaths(g.lastWrite, memObj).forEach(pt=>{ if(g.entries.some(e=> e.path === pt)) return; const v = getPath(memObj, pt); if(v !== null && typeof v === 'object') return; g.recentEdits = g.recentEdits.filter(x=> x.path !== pt); g.recentEdits.push({ path: pt, value: clone(v), at: Date.now() }); }); }catch(e){}
      g.recentEdits = g.recentEdits.filter(x=> Date.now() - x.at < 120000).slice(-50);
      let out = memObj;
      if(lsObj && !same(lsObj, g.lastWrite)){            // 自分の最後の書込みのままなら、差分は自分の新しい編集だけ＝併合不要
        if(g.causal) rAdd(lsRaw, 'event');
        const mi = mergeIncoming(memObj, lsObj, lsRaw);   // 因果：共通祖先を base に（不明なら自分の欄だけ守る）
        const r = mi.r;
        if(g.causal){ g.lastWrite = clone(lsObj); g.lastWriteId = mi.identity || g.lastWriteId; }
        upsertEntries(r.conflicts);
        reconcileEntriesWithLS(lsObj);
        applyMineToMem(r.merged);
        if(!same(r.merged, memObj)){ opts.setMem(r.merged); g.pendingIncoming = true; }   // 相手の変更をメモリへ（表示は保護解除時）
        out = clone(getMem());
        persistEntries();
        renderNotice();
      }
      const own = ownEntries();
      if(own.length){
        out = clone(out);
        own.forEach(e=>{
          const cur = lsObj ? getPath(lsObj, e.path) : e.incoming;
          if(cur === undefined) setPath(out, e.path, undefined); else setPath(out, e.path, cur);
        });
      }
      if(g.causal){
        // stamp：parent＝いま読んだ保存先テキストの identity（無ければ null＝root）。mid は内容と parent から決まる
        const C = causalLib();
        out = clone(out); stripSync(out);
        try{
          const parent = (lsRaw == null) ? null : C.identityOf(lsRaw).identity;
          out._sync = C.stampFor(out, parent);
        }catch(e){ try{ console.warn('[sakaeLocalMerge] stamp の作成に失敗（保存しません）:', e && e.message); }catch(x){} return null; }
      }
      return out;
    };

    // ---- settle の証明（S1 控え消滅 ∧ S2 LS が自分の書いた値 ∧ S3 それ以後の保存なし）----
    g.checkSettled = function(){
      g.stats.checkSettled++;
      if(!g.ownWrite) return false;
      const p = readPending();
      if(p) return false;                                          // S1 不成立：未共有のまま（fail-closed）
      const raw = readLS();
      if(raw == null || !same(parse(raw), parse(g.ownWrite.text))) return false;   // S2 不成立：別の値が settle した（adopt に任せる）
      g.base = parse(g.ownWrite.text) || g.base;                   // S1∧S2（S3 は ownWrite が最新であることで成立）
      g.ownWrite = null;
      stopFastPoll();
      return true;
    };
    function startFastPoll(){ stopFastPoll(); g.fastLeft = FAST_POLL_MAX; g.fastTimer = setInterval(()=>{ if(document.visibilityState !== 'visible') return; if(g.checkSettled() || --g.fastLeft <= 0) stopFastPoll(); }, FAST_POLL_MS); }
    function stopFastPoll(){ if(g.fastTimer){ clearInterval(g.fastTimer); g.fastTimer = null; } }
    function startSlowPoll(){ if(g.slowTimer) return; g.slowTimer = setInterval(()=>{ if(document.visibilityState !== 'visible') return; g.checkSettled(); }, SLOW_POLL_MS); }

    // ---- storage event（自キー／控えキー／送信台帳キー）----
    g.onStorage = function(e, isOwnKey){
      if(!e) return;
      const k = e.key || '';
      if(isOwnKey) g.stats.storageEvents++;
      if(k === conflictStore.key(key())){                          // 別タブで解決／更新された
        loadEntries(); const lsObj = parse(readLS()); if(lsObj) reconcileEntriesWithLS(lsObj);
        if(!opts.isProtected()){ const mem = getMem(); if(mem){ applyMineToMem(mem); } opts.render(); }
        renderNotice(); return;
      }
      if(k.indexOf('sakaeLocal_syncPending_v1_') === 0 || k.indexOf('sakaeLocal_syncOutbound_v1_') === 0){ setTimeout(g.checkSettled, 0); return; }
      // ★CAUSALRING-01：別の画面がこの案件の永続リングを書いた → 正規形と違えば自己修復（設計 v1.2 §7.4）
      if(g.causal && k === SEEN_PREFIX + key()){ if(g.pendingRing.size) evaluatePending('ring'); scheduleHeal(); return; }   // ★v1.4.3：matching ring event は期限を待たず即再評価
      // ★v1.3：別の画面がこの案件の隔離キーを書いた → 併合して隔離を除外（リングにあれば除く）・正規形と違えば自己修復
      if(g.causal && k === QUAR_PREFIX + key()){ scheduleQHeal(); return; }
      if(!isOwnKey) return;
      if(e.newValue == null) return;
      if(g.causal){
        // 因果同期：届いた書込みを「見た」として環へ（保護中で取り込みを後回しにする時も登録する＝後で parent を引ける）。
        // oldValue に頼る旧 race 修復は使わない。上書きされた側も上書きした側も、相手の parent を base にした同じ併合で 1 回だけ修復する。
        const inc = rAdd(e.newValue, 'event');
        if(inc) addPending(inc.mid);   // ★v1.4.3：取込みは即時のまま、リングへの記録だけ書き手の own を待つ
        const run = ()=>{ if(opts.isProtected()){ g.pendingIncoming = true; return; } g.adopt(); };
        if(e.isTrusted === false) setTimeout(run, 0);   // 同期層の受信中（applyingRemoteUpdate）に保存すると共有へ送られないため、受信処理の外で行う
        else run();
        return;
      }
      // ---- 交錯（race）の修復（因果同期を持たない画面＝案件一覧のみ）----
      // localStorage には「読んで・併合して・書く」を不可分にする手段が無い。別タブが、こちらが読んだ直後・書く直前に書くと、
      // こちらの書込みが相手の変更を上書きしてしまう。それは「相手の書込みイベントの oldValue が、こちらが最後に書く前の値
      // （prevLastWrite）と一致し、newValue がこちらの lastWrite と違う」ことで見分けられる。
      // その時だけ、prevLastWrite を base に 自分の書込み と 相手の書込み を併合して 1 回だけ書き直す（相手の変更を取り戻す）。
      try{
        if(e.oldValue != null && g.prevLastWrite && g.lastWrite && !same(parse(e.newValue), g.lastWrite)
           && same(parse(e.oldValue), g.prevLastWrite) && g.ownWrite && (Date.now() - g.ownWrite.at) < 5000){
          const theirs = parse(e.newValue);
          const cur = parse(readLS());
          // 保存先がまだ自分の書込みのまま（＝自分が相手を上書きした）時だけ修復する
          if(theirs && cur && same(cur, g.lastWrite)){
            const r = opts.merge(g.prevLastWrite, g.lastWrite, theirs);
            upsertEntries(r.conflicts);
            const mem = getMem();
            const r2 = opts.merge(g.lastWrite, mem, r.merged);            // 併合結果をメモリにも重ねる（自分の未保存分は残す）
            upsertEntries(r2.conflicts);
            applyMineToMem(r2.merged);
            opts.setMem(r2.merged);
            // lastWrite はまだ自分の書込みのまま（保存先と一致）にしておく → 直後の save() は併合し直さず、mem（併合結果）をそのまま書く
            persistEntries();
            if(!opts.isProtected()) opts.render(); else g.pendingIncoming = true;
            renderNotice();
            try{ opts.save(); }catch(err){}                                // 1 回だけ書き直す（次の event は oldValue が違うので再修復しない）
            return;
          }
        }
      }catch(err){}
      if(opts.isProtected()){ g.pendingIncoming = true; return; }  // 書かない・描き直さない・保留
      g.adopt();
    };
    g.onProtectionEnd = function(){ if(g.pendingIncoming && !opts.isProtected()) g.adopt(); };

    // ---- 取り込み ----
    g.adopt = function(){
      g.pendingIncoming = false;
      g.stats.adopt++;
      g.checkSettled();
      const raw = readLS();
      const incoming = parse(raw);
      if(!incoming) return false;
      const mem = getMem();
      if(!mem) return false;
      if(same(incoming, g.lastWrite) && !g.entries.length){ if(g.causal){ const e0 = rAdd(raw, 'event'); if(e0) g.lastWriteId = e0.mid; } return false; }   // 自分の書込みが戻ってきただけ（内容が同じ）
      if(g.causal) rAdd(raw, 'event');
      const mi = mergeIncoming(mem, incoming, raw);
      const r = mi.r;
      const merged = r.merged;
      upsertEntries(r.conflicts);
      // 直近に自分が編集した欄が相手の値へ置き換わる場合は、黙って置き換えず知らせる（元に戻せる）
      try{
        const now = Date.now();
        g.recentEdits.filter(x=> now - x.at < 120000).forEach(x=>{
          const after = getPath(merged, x.path);
          if(!same(after, x.value) && !r.conflicts.some(c=> c.path === x.path) && !g.entries.some(e=> e.path === x.path)){
            g.infos = g.infos.filter(y=> y.path !== x.path);
            g.infos.push({ path: x.path, mine: clone(x.value), incoming: clone(after), at: now });
          }
        });
      }catch(e){}
      g.infos = g.infos.filter(x=> !same(getPath(merged, x.path), x.mine));   // 自分の値へ戻った欄の通知は取り下げる
      if(!readPending()) g.base = clone(incoming);   // 控えが無い＝保存先は共有と一致（F2）→ 共有の基準として採用してよい
      // base：same-field の欄は「相手の値＝共有の現状」を基準にする
      const baseNext = clone(merged);
      g.entries.forEach(e=>{ if(e.incoming === null || e.incoming === undefined) setPath(baseNext, e.path, undefined); else setPath(baseNext, e.path, e.incoming); });
      reconcileEntriesWithLS(incoming);
      applyMineToMem(merged);
      opts.setMem(merged);
      g.base = baseNext;
      g.prevLastWrite = g.lastWrite;
      g.lastWrite = clone(incoming);
      if(g.causal){ g.lastWriteId = mi.identity || g.lastWriteId; if(mi.identity) addPending(mi.identity); rPersist(false); }   // ★v1.4.3：pending 中の mid はここで書かない
      persistEntries();
      opts.render();
      renderNotice();
      // 自分の未共有の変更（disjoint）が残っていれば 1 回だけ保存して相手・共有へ渡す（same-field は prepareSave で除外される）
      // ★もう 1 つ：直前（デバウンス 500ms 以内）に自分が保存していて、その内容が届いた値と違うなら、同期層がまだ送っていない
      //   自分の古い内容がそのまま共有へ飛んでしまう。併合結果で保存し直して、送る内容を最新へ差し替える（1 回・相手側では同値なので往復しない）
      const staleOwnPush = !!(g.ownWrite && (Date.now() - g.ownWrite.at) < 700 && !same(incoming, parse(g.ownWrite.text)));
      const prepared = g.prepareSave(merged);
      if(prepared === null) return true;                                     // 因果同期が使えない＝書かない
      if(!same(g.causal ? stripSync(clone(prepared)) : prepared, incoming) || staleOwnPush){ try{ opts.save(); }catch(e){} }
      return true;
    };

    // ---- 解決 ----
    g.resolveMine = function(path){
      const e = g.entries.find(x=> x.path === path); if(!e) return;
      const mem = getMem();
      if(e.mine === null || e.mine === undefined) setPath(mem, path, undefined); else setPath(mem, path, e.mine);
      g.entries = g.entries.filter(x=> x !== e);
      persistEntries();
      opts.setMem(mem);
      g.base = (function(){ const b = clone(g.base); setPath(b, path, e.incoming === undefined ? undefined : e.incoming); return b; })();
      try{ opts.save(); }catch(err){}                              // 利用者の明示操作としての保存
      if(typeof opts.onResolve === 'function'){ try{ opts.onResolve({ path: path, chosen: 'mine', value: e.mine }); }catch(err){} }   // 解決結果を画面側の派生データへ（TOPFORM-01・任意）
      opts.render(); renderNotice();
    };
    g.resolveTheirs = function(path){
      const e = g.entries.find(x=> x.path === path); if(!e) return;
      // J-11：解決の直前に LS の現在値を読み直す。表示していた incoming と違えば更新して選び直してもらう
      const lsObj = parse(readLS());
      const cur = lsObj ? getPath(lsObj, path) : e.incoming;
      if(!same(cur, e.incoming)){ e.incoming = clone(cur); persistEntries(); renderNotice(true); return; }
      const mem = getMem();
      if(cur === undefined) setPath(mem, path, undefined); else setPath(mem, path, cur);
      g.entries = g.entries.filter(x=> x !== e);
      persistEntries();
      opts.setMem(mem);
      if(typeof opts.onResolve === 'function'){ try{ opts.onResolve({ path: path, chosen: 'theirs', value: cur }); }catch(err){} }   // 解決結果を画面側の派生データへ（TOPFORM-01・任意）
      opts.render(); renderNotice();
    };
    // ---- 画面側で見つけた「同じ欄の重なり」を控えへ登録する（SAKAE-TOPFORM-01・追加 API。既存の併合・検出・解決の意味は変えない）----
    //   list：[{ path, base, mine, incoming }]。登録後はメモリに自分の値を保ち、保存時は prepareSave が保存先の現在値で書く（既存の fail-closed と同じ扱い）
    g.noteConflicts = function(list){
      if(!Array.isArray(list) || !list.length) return;
      upsertEntries(list);
      try{ const mem = getMem(); if(mem) applyMineToMem(mem); }catch(e){}
      persistEntries();
      renderNotice(true);
    };

    g.revertInfo = function(path){
      const x = g.infos.find(y=> y.path === path); if(!x) return;
      const mem = getMem();
      setPath(mem, path, x.mine);
      g.infos = g.infos.filter(y=> y !== x);
      opts.setMem(mem);
      try{ opts.save(); }catch(err){}                              // 利用者の明示操作としての保存
      opts.render(); renderNotice();
    };
    g.dismissInfo = function(path){ g.infos = g.infos.filter(y=> y.path !== path); renderNotice(); };

    // ---- 通知 ----
    function renderNotice(changed){
      let box = document.getElementById('sakaeFieldConflictNotice');
      if(!g.entries.length && !g.infos.length && !g.warnings.length){ if(box) box.remove(); return; }
      if(!box){
        box = document.createElement('div');
        box.id = 'sakaeFieldConflictNotice';
        box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99990;background:#fff7e6;border:2px solid #e08a00;border-radius:10px;padding:10px 14px;font-size:13px;color:#3a2a00;box-shadow:0 6px 24px rgba(0,0,0,.18);font-family:"Hiragino Sans","Yu Gothic",sans-serif;';
        document.body.appendChild(box);
      }
      let html = '';
      g.warnings.forEach(w=>{
        html += '<div data-sakae="' + esc(w.code) + '" style="font-weight:700;margin-bottom:4px;color:#8a1f00;">' + esc(w.text) + '</div>';
      });
      if(g.infos.length){
        html += '<div style="font-weight:700;margin-bottom:4px;">他の画面・端末の変更で、直前に入力した欄が更新されました</div>';
        g.infos.forEach(x=>{
          html += '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:3px 0;">'
            + '<span style="min-width:120px;font-weight:600;">' + esc(labelOf(x.path)) + '</span>'
            + '<span>直前の入力：<b>' + esc(short(x.mine)) + '</b> → 現在：<b>' + esc(short(x.incoming)) + '</b></span>'
            + '<button type="button" data-fi="revert" data-path="' + esc(x.path) + '" style="padding:3px 10px;">元に戻す</button>'
            + '<button type="button" data-fi="ok" data-path="' + esc(x.path) + '" style="padding:3px 10px;">了解</button></div>';
        });
      }
      if(g.entries.length) html += '<div style="font-weight:700;margin:6px 0 4px;">他の画面・端末の変更と同じ欄が重なりました。どちらを残すか選んでください（選ぶまで共有側は相手の値のままです）</div>';
      g.entries.forEach(e=>{
        html += '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:4px 0;border-top:1px solid #f0d9a8;">'
          + '<span style="min-width:120px;font-weight:600;">' + esc(labelOf(e.path)) + '</span>'
          + '<span>こちら：<b>' + esc(short(e.mine)) + '</b></span><span>相手：<b>' + esc(short(e.incoming)) + '</b>' + (changed ? '（更新されました）' : '') + '</span>'
          + '<button type="button" data-fc="mine" data-path="' + esc(e.path) + '" style="padding:4px 10px;">こちらを残す</button>'
          + '<button type="button" data-fc="theirs" data-path="' + esc(e.path) + '" style="padding:4px 10px;">相手の値にする</button></div>';
      });
      box.innerHTML = html;
      box.onclick = function(ev){
        const bi = ev.target.closest('button[data-fi]');
        if(bi){ if(bi.dataset.fi === 'revert') g.revertInfo(bi.dataset.path); else g.dismissInfo(bi.dataset.path); return; }
        const b = ev.target.closest('button[data-fc]'); if(!b) return;
        if(b.dataset.fc === 'mine') g.resolveMine(b.dataset.path); else g.resolveTheirs(b.dataset.path);
      };
    }
    function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c=> ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

    // 診断（読むだけ・試験用）
    g.snapshot = function(){
      let mem = null; try{ mem = getMem(); }catch(e){}
      return { page: opts.page, key: key(), base: clone(g.base), lastWrite: clone(g.lastWrite), ownWrite: clone(g.ownWrite),
               pendingIncoming: g.pendingIncoming, entries: clone(g.entries), infos: clone(g.infos), stats: clone(g.stats),
               causal: g.causal, lastWriteId: g.lastWriteId, degraded: g.degraded, warnings: clone(g.warnings), lastMerge: clone(g.lastMerge || null),
               R: g.R.map(e=> ({ mid: e.mid, parent: e.parent, at: e.at, src: e.src, legacy: e.legacy })),
               degradedReasons: g.degradedReasons.slice(), quarantinedMids: g.quarantine.map(m=> String(m).slice(0, 8)),
               pendingMids: Array.from(g.pendingRing.keys()).map(m=> String(m).slice(0, 8)), pendingTimer: !!g.pendingTimer, pendingOverflowActive: g.pendingOverflowActive, pendingLog: clone(g.pendingLog),
               lastOwnMid: g.lastOwnMid ? String(g.lastOwnMid).slice(0, 8) : null, lastOwnAt: g.lastOwnAt, markerBroken: g.markerBroken, capRecoveryUsed: g.capRecoveryUsed,
               quarantineSize: g.quarantine.length, qBrokenSince: g.qBrokenSince, quarantineItems: g.quarantine.map(m=>{ const it = g.qItems.get(m); return { mid: String(m).slice(0, 8), detectedAt: it ? it.detectedAt : null }; }),
               mismatchLog: clone(g.mismatchLog), healLog: clone(g.healLog),
               dirty: !!(mem && g.lastWrite && !same(mem, g.lastWrite)), baseSettled: !!(mem && g.base && same(mem, g.base)), fastPolling: !!g.fastTimer };
    };
    return g;
  }

  window.sakaeLocalMerge = {
    stable: stable, same: same, clone: clone,
    getPath: getPath, setPath: setPath, diffPaths: diffPaths,
    merge3Buhin: merge3Buhin, mergeRecords: mergeRecords,
    conflictStore: conflictStore, labelOf: labelOf,
    createGuard: createGuard,
    CONFLICT_STORE_PREFIX: CONFLICT_STORE_PREFIX
  };
})();
