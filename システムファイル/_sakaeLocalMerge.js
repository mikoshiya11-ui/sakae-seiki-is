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
    g.degraded = false;            // この key の因果記録が復元できない／永続できない（UNKNOWN は全差分を選ばせる）
    g.warnings = [];               // 画面に出す診断（因果同期が使えない・記録を保存できない）
    g.stats.invalid = { version: 0, mid: 0, parent: 0, shape: 0, parse: 0, persisted: 0 };
    g.stats.skip = 0; g.stats.known = 0; g.stats.unknown = 0; g.stats.persistFail = 0;
    const R_MEM_MAX = 16, R_PERSIST_MAX = 6, R_TTL_MS = 24 * 3600 * 1000, R_INDEX_MAX_KEYS = 20, R_PERSIST_BYTES = 512 * 1024;
    const SEEN_PREFIX = 'sakaeLocal_seen_v1_', SEEN_INDEX = 'sakaeLocal_seenIndex_v1';   // sakaeLocal_ ＝ 同期対象外・控え対象外
    const causalLib = ()=> window.sakaeCausal || null;
    const stripSync = (o)=>{ if(o && typeof o === 'object' && !Array.isArray(o) && o._sync !== undefined) delete o._sync; return o; };
    // 画面のメモリ（state）は読み込み時の _sync を持ち得る。guard の比較は業務内容だけで行う
    const getMem = ()=>{ const m = opts.getMem(); return g.causal ? stripSync(m) : m; };
    const rawContentOf = (raw)=>{ const C = causalLib(); try{ return C ? C.contentOf(JSON.parse(raw)) : JSON.parse(raw); }catch(e){ return null; } };
    const productOfEntry = (e)=> parse(JSON.stringify(e.product));   // 環の写し（生）→ 画面の形（migrate 済み・_sync 無し）
    function rFind(mid){ return mid ? g.R.find(e=> e.mid === mid) : null; }
    // 環への登録：契約 C-03 の検証（v／mid 再計算／parent 形式／内容の形）に通ったものだけ。INVALID は登録しない
    function rAdd(raw, src){
      const C = causalLib(); if(!C || raw == null) return null;
      let info; try{ info = C.identityOf(raw); }catch(e){ return null; }
      if(info.state === 'INVALID'){ (info.reasons || ['shape']).forEach(rs=>{ if(g.stats.invalid[rs] !== undefined) g.stats.invalid[rs]++; }); return null; }
      const ex = rFind(info.identity);
      if(ex){ ex.at = Date.now(); if(src === 'own') ex.src = 'own'; return ex; }
      const e = { mid: info.identity, parent: info.parent, product: info.content, at: Date.now(), src: src, legacy: info.state === 'LEGACY' };
      g.R.push(e);
      if(g.R.length > R_MEM_MAX){ g.R.sort((a, b)=> a.at - b.at); g.R.splice(0, g.R.length - R_MEM_MAX); }
      return e;
    }
    // 永続化：直近 R_PERSIST_MAX 件＋index。失敗は黙らない（DEGRADED を記録し、UNKNOWN の保護を広げる）
    function rIndexRead(){ try{ const o = JSON.parse(localStorage.getItem(SEEN_INDEX) || 'null'); return (o && typeof o === 'object') ? o : {}; }catch(e){ return {}; } }
    function rPersist(ownWrite){
      if(!g.causal) return;
      const k = key(); if(!k) return;
      const now = Date.now();
      const idx = rIndexRead();
      const mine = idx[k] || { lastOwnAt: 0, ownCount: 0, degraded: false };
      if(ownWrite){ mine.lastOwnAt = now; mine.ownCount = (mine.ownCount || 0) + 1; }
      let entries = g.R.slice().sort((a, b)=> b.at - a.at).slice(0, R_PERSIST_MAX);
      let body = JSON.stringify({ v: 1, entries: entries, updatedAt: now });
      if(body.length > R_PERSIST_BYTES){ entries = entries.slice(0, 3); body = JSON.stringify({ v: 1, entries: entries, updatedAt: now }); }
      try{
        // index を先に（この key に own 書込みがあった事実を残す）。古い key は落とす
        const keys = Object.keys(idx).filter(x=> x !== k).sort((a, b)=> (idx[b].lastOwnAt || 0) - (idx[a].lastOwnAt || 0)).slice(0, R_INDEX_MAX_KEYS - 1);
        const next = {}; keys.forEach(x=>{ next[x] = idx[x]; });
        mine.degraded = false; mine.reason = '';
        next[k] = mine;
        localStorage.setItem(SEEN_INDEX, JSON.stringify(next));
        localStorage.setItem(SEEN_PREFIX + k, body);
        try{ localStorage.removeItem('sakaeLocal_seenDegraded_v1'); }catch(x){}   // index も R も書けた＝全体 DEGRADED の印は下ろす
        if(g.degraded){ g.degraded = false; g.warnings = g.warnings.filter(w=> w.code !== 'degraded'); renderNotice(); }
      }catch(e){
        g.stats.persistFail++;
        markDegraded('persist', e);
      }
    }
    function markDegraded(reason, e){
      const k = key();
      if(!g.degraded){ try{ console.warn('[sakaeLocalMerge] 同期の因果記録を保存できません（保護を強めます）:', k, reason, e && e.message); }catch(x){} }
      g.degraded = true;
      if(!g.warnings.some(w=> w.code === 'degraded')) g.warnings.push({ code: 'degraded', text: '同期の因果記録を保存できません（この画面では、他の画面・端末の変更と重なった欄を自動で決めず、選んでいただきます）' });
      try{ const idx = rIndexRead(); idx[k] = Object.assign(idx[k] || { lastOwnAt: Date.now(), ownCount: 0 }, { degraded: true, reason: String(reason) }); localStorage.setItem(SEEN_INDEX, JSON.stringify(idx)); }
      catch(x){ try{ localStorage.setItem('sakaeLocal_seenDegraded_v1', '1'); }catch(y){} }
      renderNotice();
    }
    // 起動時の復元：永続 R を全件再検証（mid は product＋parent から再計算して照合）。不合格は捨てる
    function rLoad(){
      const C = causalLib(); if(!C) return;
      const k = key(); if(!k) return;
      let stored = null;
      try{ stored = JSON.parse(localStorage.getItem(SEEN_PREFIX + k) || 'null'); }catch(e){ stored = 'broken'; }
      let ownRestored = 0;
      if(stored && stored !== 'broken' && stored.v === 1 && Array.isArray(stored.entries)){
        stored.entries.forEach(e=>{
          try{
            if(!e || typeof e !== 'object' || !e.product || (e.parent !== null && !C.isHex64(e.parent))) throw new Error('shape');
            const info = C.identityOf(e.parent === null ? e.product : Object.assign({}, e.product, { _sync: { v: C.VERSION, parent: e.parent, mid: e.mid } }));
            if(info.state === 'INVALID' || info.identity !== e.mid) throw new Error('mid');
            if(Date.now() - (e.at || 0) > R_TTL_MS) return;
            if(!rFind(e.mid)){ g.R.push({ mid: e.mid, parent: e.parent, product: info.content, at: e.at || Date.now(), src: e.src === 'own' ? 'own' : 'event', legacy: !!e.legacy }); if(e.src === 'own') ownRestored++; }
          }catch(x){ g.stats.invalid.persisted++; }
        });
      }
      const idx = rIndexRead()[k];
      const recentOwn = !!(idx && (Date.now() - (idx.lastOwnAt || 0)) < R_TTL_MS && (idx.ownCount || 0) > 0);
      const hasPending = !!readPending();
      if(idx && idx.degraded) markDegraded('index', null);
      else if(recentOwn && ownRestored === 0 && !hasPending) markDegraded(stored === 'broken' ? 'broken' : 'missing', null);
      try{ if(localStorage.getItem('sakaeLocal_seenDegraded_v1') === '1') markDegraded('marker', null); }catch(e){}
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
      g.R.filter(e=> e.src === 'own' && Date.now() - e.at < R_TTL_MS).sort((a, b)=> b.at - a.at).forEach(e=>{
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
      if(g.causal){ const e = rAdd(text, 'own'); if(e){ g.lastWriteId = e.mid; } rPersist(true); }
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
      if(!isOwnKey) return;
      if(e.newValue == null) return;
      if(g.causal){
        // 因果同期：届いた書込みを「見た」として環へ（保護中で取り込みを後回しにする時も登録する＝後で parent を引ける）。
        // oldValue に頼る旧 race 修復は使わない。上書きされた側も上書きした側も、相手の parent を base にした同じ併合で 1 回だけ修復する。
        rAdd(e.newValue, 'event');
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
      if(g.causal){ g.lastWriteId = mi.identity || g.lastWriteId; rPersist(false); }
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
