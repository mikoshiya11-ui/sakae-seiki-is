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
    const parse = (raw)=> { try{ return raw == null ? null : opts.parse(raw); }catch(e){ return null; } };
    const readPending = ()=> { try{ return (window.sakaeSyncRead && window.sakaeSyncRead.getPending) ? window.sakaeSyncRead.getPending(key()) : null; }catch(e){ return null; } };

    // ---- 退避の読み書き ----
    function loadEntries(){ const rec = conflictStore.read(key()); g.entries = rec ? rec.entries.slice() : []; }
    function persistEntries(){
      conflictStore.write(key(), g.entries.length ? { version: 1, syncKey: key(), dataType: opts.dataType || '', recordId: opts.recordId || '', productNo: opts.productNo || '', entries: g.entries } : null);
    }
    function upsertEntries(conflicts){
      conflicts.forEach(c=>{
        const ex = g.entries.find(e=> e.path === c.path);
        if(ex){ ex.incoming = clone(c.incoming); }      // 相手がさらに変えた → incoming だけ更新。mine は保持
        else g.entries.push({ path: c.path, base: clone(c.base), mine: clone(c.mine), incoming: clone(c.incoming), detectedAt: new Date().toISOString(), pageId: g.pageId, byPage: opts.page || '' });
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
      loadEntries();
      if(lsObj) reconcileEntriesWithLS(lsObj);
      if(g.entries.length){
        const mem = opts.getMem();
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

    // ---- 保存直後（各画面の保存関数の末尾で呼ぶ）----
    g.noteOwnSave = function(savedText){
      const text = (typeof savedText === 'string') ? savedText : (readLS() || '');
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
      const lsObj = parse(readLS());
      // 直近の自分の編集＝メモリと最後の書込みの差（相手の値へ置き換わった時に「元に戻す」を出すため）
      // 欄（スカラー値）だけを覚える。部品・工程の追加／削除（要素そのもの）は「欄の入力」ではないので対象外
      try{ diffPaths(g.lastWrite, memObj).forEach(pt=>{ if(g.entries.some(e=> e.path === pt)) return; const v = getPath(memObj, pt); if(v !== null && typeof v === 'object') return; g.recentEdits = g.recentEdits.filter(x=> x.path !== pt); g.recentEdits.push({ path: pt, value: clone(v), at: Date.now() }); }); }catch(e){}
      g.recentEdits = g.recentEdits.filter(x=> Date.now() - x.at < 120000).slice(-50);
      let out = memObj;
      if(lsObj && !same(lsObj, g.lastWrite)){            // 自分の最後の書込みのままなら、差分は自分の新しい編集だけ＝併合不要
        const r = opts.merge(g.lastWrite || g.base, memObj, lsObj);
        upsertEntries(r.conflicts);
        reconcileEntriesWithLS(lsObj);
        applyMineToMem(r.merged);
        if(!same(r.merged, memObj)){ opts.setMem(r.merged); g.pendingIncoming = true; }   // 相手の変更をメモリへ（表示は保護解除時）
        out = clone(opts.getMem());
        persistEntries();
        renderNotice();
      }
      const own = ownEntries();
      if(!own.length) return out;
      out = clone(out);
      own.forEach(e=>{
        const cur = lsObj ? getPath(lsObj, e.path) : e.incoming;
        if(cur === undefined) setPath(out, e.path, undefined); else setPath(out, e.path, cur);
      });
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
        if(!opts.isProtected()){ const mem = opts.getMem(); if(mem){ applyMineToMem(mem); } opts.render(); }
        renderNotice(); return;
      }
      if(k.indexOf('sakaeLocal_syncPending_v1_') === 0 || k.indexOf('sakaeLocal_syncOutbound_v1_') === 0){ setTimeout(g.checkSettled, 0); return; }
      if(!isOwnKey) return;
      if(e.newValue == null) return;
      // ---- 交錯（race）の修復 ----
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
            const mem = opts.getMem();
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
      const mem = opts.getMem();
      if(!mem) return false;
      if(same(incoming, g.lastWrite) && !g.entries.length){ return false; }   // 自分の書込みが戻ってきただけ
      const r = opts.merge(g.lastWrite || g.base, mem, incoming);
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
      persistEntries();
      opts.render();
      renderNotice();
      // 自分の未共有の変更（disjoint）が残っていれば 1 回だけ保存して相手・共有へ渡す（same-field は prepareSave で除外される）
      // ★もう 1 つ：直前（デバウンス 500ms 以内）に自分が保存していて、その内容が届いた値と違うなら、同期層がまだ送っていない
      //   自分の古い内容がそのまま共有へ飛んでしまう。併合結果で保存し直して、送る内容を最新へ差し替える（1 回・相手側では同値なので往復しない）
      const staleOwnPush = !!(g.ownWrite && (Date.now() - g.ownWrite.at) < 700 && !same(incoming, parse(g.ownWrite.text)));
      if(!same(g.prepareSave(merged), incoming) || staleOwnPush){ try{ opts.save(); }catch(e){} }
      return true;
    };

    // ---- 解決 ----
    g.resolveMine = function(path){
      const e = g.entries.find(x=> x.path === path); if(!e) return;
      const mem = opts.getMem();
      if(e.mine === null || e.mine === undefined) setPath(mem, path, undefined); else setPath(mem, path, e.mine);
      g.entries = g.entries.filter(x=> x !== e);
      persistEntries();
      opts.setMem(mem);
      g.base = (function(){ const b = clone(g.base); setPath(b, path, e.incoming === undefined ? undefined : e.incoming); return b; })();
      try{ opts.save(); }catch(err){}                              // 利用者の明示操作としての保存
      opts.render(); renderNotice();
    };
    g.resolveTheirs = function(path){
      const e = g.entries.find(x=> x.path === path); if(!e) return;
      // J-11：解決の直前に LS の現在値を読み直す。表示していた incoming と違えば更新して選び直してもらう
      const lsObj = parse(readLS());
      const cur = lsObj ? getPath(lsObj, path) : e.incoming;
      if(!same(cur, e.incoming)){ e.incoming = clone(cur); persistEntries(); renderNotice(true); return; }
      const mem = opts.getMem();
      if(cur === undefined) setPath(mem, path, undefined); else setPath(mem, path, cur);
      g.entries = g.entries.filter(x=> x !== e);
      persistEntries();
      opts.setMem(mem);
      opts.render(); renderNotice();
    };

    g.revertInfo = function(path){
      const x = g.infos.find(y=> y.path === path); if(!x) return;
      const mem = opts.getMem();
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
      if(!g.entries.length && !g.infos.length){ if(box) box.remove(); return; }
      if(!box){
        box = document.createElement('div');
        box.id = 'sakaeFieldConflictNotice';
        box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99990;background:#fff7e6;border:2px solid #e08a00;border-radius:10px;padding:10px 14px;font-size:13px;color:#3a2a00;box-shadow:0 6px 24px rgba(0,0,0,.18);font-family:"Hiragino Sans","Yu Gothic",sans-serif;';
        document.body.appendChild(box);
      }
      let html = '';
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
      let mem = null; try{ mem = opts.getMem(); }catch(e){}
      return { page: opts.page, key: key(), base: clone(g.base), lastWrite: clone(g.lastWrite), ownWrite: clone(g.ownWrite),
               pendingIncoming: g.pendingIncoming, entries: clone(g.entries), infos: clone(g.infos), stats: clone(g.stats),
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
