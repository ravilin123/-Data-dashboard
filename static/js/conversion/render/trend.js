import { ALLOWED_SOURCES, P } from '../config.js';
import { state } from '../store.js';
import { $, esc } from '../../shared/dom.js';
import { pct } from '../util.js';

/* ---------- 多期趋势（B5） ----------

   为什么值得单独一块：页面其余部分全是「两期对比」，而最难发现的那类问题
   恰恰在两期之间看不出来 —— 每期掉 0.3pt，十期掉 3pt，没有一期会触发阈值。

   配色是**按来源固定的三支分类色**，跑过 dataviz 的六项校验（CVD 相邻色差、
   normal-vision 下限、色度、明度带、对比度），浅深两套各验一遍。
   ⚠️ 语义色（--good/--warning/--serious/--critical）**不许**拿来当第四条线用：
   整个页面靠语义色传严重度，一旦某条线是绿的就会被读成「这条是好的」。
   ⚠️ 取色**按 ALLOWED_SOURCES 的下标**，不按本次画了几条线 ——
   某个来源某天整个没数据时，剩下两条的颜色不能跟着换位。 */

const SERIES_VAR = ['--s1','--s2','--s3'];
const colorOf = src => `var(${SERIES_VAR[Math.max(0, ALLOWED_SOURCES.indexOf(src)) % SERIES_VAR.length]})`;

/** 期次标签：日报去掉年份，周报只留 W37，月报原样 —— 横轴放不下完整写法。 */
function tickLabel(d){
  const s=String(d||'');
  const w=s.match(/W\s*(\d+)/i); if(w) return 'W'+w[1];
  const day=s.match(/^\d{4}-(\d{2}-\d{2})$/); if(day) return day[1];
  return s;
}

const dot=(x,y,col)=>`<circle class="tr-dot" style="fill:${col}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4"/>`;

const NICE = [0.0005,0.001,0.002,0.0025,0.005,0.01,0.02,0.025,0.05,0.1,0.2,0.25,0.5];
/** 跨度 span 上不超过 max 条网格线的**最小**整齐刻度。 */
function niceStep(span, max){
  for(const s of NICE) if(span/s <= max) return s;
  return 1;
}
/**
 * 纵轴范围。折线图不强制从 0 起（那是柱图的规矩），但**必须留白 + 对齐到整齐刻度**，
 * 否则 0.1pt 的抖动会被拉满整个画布，看起来像崩了。
 *
 * ⚠️ 刻度取「切得下的最小那档」，不是「按目标格数算出来的那档」。
 *   后者是第一版的写法：0.16~0.62 这段算出 0.2 一档 → 对齐成 0~80%，
 *   数据全挤在中间一条，上下各空掉四分之一张图。
 * 全都一样高时给一个固定窄带，不要除以 0。
 */
function domainOf(vals){
  const v=vals.filter(x=>x!=null && Number.isFinite(x));
  if(!v.length) return null;
  const mn=Math.min(...v), mx=Math.max(...v);
  let lo=mn, hi=mx;
  if(hi===lo){ lo-=0.005; hi+=0.005; }
  const pad=(hi-lo)*0.15; lo-=pad; hi+=pad;
  if(mn>=0) lo=Math.max(0,lo);       // 比率不会是负的
  if(mx<=1) hi=Math.min(1,hi);       // 通过率的天花板；ALLOW_OVER_ONE 那个超过 1 时不封
  /* ⚠️ **不把 lo/hi 撑到刻度线上** —— 撑出去等于给数据加留白：
     0.17~0.63 一撑就是 0~80%，八期数据挤在中间三分之一，上下各空一块。
     刻度改成「落在范围内的整数倍」，数据永远铺满画布，刻度照样是整数。 */
  const step=niceStep(hi-lo, 6);
  return {lo, hi, step};
}

/**
 * 画一张折线图，返回 {html, geom}。
 * geom 交给 wire() 做十字光标 —— 悬停时不重算坐标，图上画的和读出来的必然一致。
 */
function lineChart(t, key, o){
  const {w, h, padL, padR, padT, padB, dots=true, endLabels=false, title=''} = o;
  const x0=padL, x1=w-padR, y0=padT, y1=h-padB;
  const rows=t.series[key]||{};
  const flat=[]; for(const s of t.sources) for(const v of (rows[s]||[])) flat.push(v);
  const dom=domainOf(flat);
  if(!dom) return {html:`<div class="hint" style="padding:8px 0">${esc(title)}：这几期都没数据</div>`, geom:null};

  const n=t.dates.length;
  const X=i => n<=1 ? (x0+x1)/2 : x0+(x1-x0)*i/(n-1);
  const Y=v => y1-(y1-y0)*(v-dom.lo)/(dom.hi-dom.lo);

  const parts=[];
  // 网格：一格一档，实线发丝级，压在数据下面
  const dec=dom.step*100<1 ? 2 : ((dom.step*100)%1 ? 1 : 0);
  for(let k=Math.ceil(dom.lo/dom.step); k*dom.step<=dom.hi+1e-9; k++){
    const g=k*dom.step, y=Y(g).toFixed(1);
    parts.push(`<line class="tr-grid" x1="${x0}" x2="${x1}" y1="${y}" y2="${y}"/>`);
    parts.push(`<text class="tr-ax" x="${x0-6}" y="${y}" text-anchor="end" dominant-baseline="middle">${(g*100).toFixed(dec)}%</text>`);
  }
  // 横轴期次。点多了隔一个标一个，宁可少标也不要叠字
  const every=n>8?Math.ceil(n/8):1;
  t.dates.forEach((d,i)=>{
    if(i%every && i!==n-1) return;
    parts.push(`<text class="tr-ax" x="${X(i).toFixed(1)}" y="${y1+15}" text-anchor="middle">${esc(tickLabel(d))}${t.partial[i]?'*':''}</text>`);
  });

  const geom={x:[...Array(n)].map((_,i)=>X(i)), plot:{x0,x1,y0,y1}, w, h, series:[]};
  for(const src of t.sources){
    const vs=rows[src]||[];
    const col=colorOf(src);
    /* 断线要断开画，**不能跨过缺口连一条直线** —— 那条直线是编出来的数据。
       同理，「本期还没走完」的最后一段画虚线：它天生偏低，实线会被读成真的在掉。 */
    let seg=[], last=null, segPartial=false;
    const flush=dash=>{
      if(seg.length>1) parts.push(`<path class="tr-line${dash?' part':''}" style="stroke:${col}" d="M${seg.map(p=>`${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}"/>`);
      else if(seg.length===1) parts.push(`<circle class="tr-dot" style="fill:${col}" cx="${seg[0][0].toFixed(1)}" cy="${seg[0][1].toFixed(1)}" r="4"/>`);
      seg=[];
    };
    const pts=[];
    vs.forEach((v,i)=>{
      if(v==null || !Number.isFinite(v)){ flush(segPartial); segPartial=false; pts.push(null); return; }
      const p=[X(i), Y(v)];
      // 进入「未走完」的那一期时先把实线段收掉，再单独画一段虚线
      if(seg.length && t.partial[i] && !t.partial[i-1]){ const tail=seg[seg.length-1]; flush(false); seg=[tail]; }
      if(t.partial[i]) segPartial=true;
      seg.push(p); last={i, v, x:p[0], y:p[1]};
      pts.push({i, v, x:p[0], y:p[1]});
    });
    flush(segPartial);
    /* 主图每点一个圆点（8px + 2px 同底色描边，压线也认得出）；
       小图点密，只留末点，其余靠十字光标读。 */
    if(dots){ for(const p of pts) if(p) parts.push(dot(p.x,p.y,col)); }
    else if(last) parts.push(dot(last.x,last.y,col));
    geom.series.push({src, col, pts, last, po:t.po[src]||[]});
  }

  /* 末端直标。图例永远在（不能只靠颜色认线），直标是**补充**：
     线一多就会在右缘挤到一起，那时候把标签挪开反而读不出它属于哪条线 ——
     挤了就整批不画，交给图例和 tooltip。 */
  if(endLabels){
    const lab=geom.series.filter(s=>s.last).map(s=>({src:s.src, col:s.col, y:s.last.y, x:s.last.x}))
                          .sort((a,b)=>a.y-b.y);
    const tight=lab.some((l,i)=>i && l.y-lab[i-1].y<13);
    if(!tight) for(const l of lab){
      parts.push(`<circle class="tr-key" style="fill:${l.col}" cx="${(x1+9).toFixed(1)}" cy="${l.y.toFixed(1)}" r="3.5"/>`);
      parts.push(`<text class="tr-end" x="${(x1+16).toFixed(1)}" y="${l.y.toFixed(1)}" dominant-baseline="middle">${esc(l.src)}</text>`);
    }
  }

  // 十字光标 + 命中层：整块画布都是热区，读的人瞄的是「哪一期」，不是那 2px 的线
  parts.push(`<line class="tr-cross" x1="0" x2="0" y1="${y0}" y2="${y1}" style="display:none"/>`);
  parts.push(`<g class="tr-hl"></g>`);
  parts.push(`<rect class="tr-hit" x="${x0}" y="${y0}" width="${x1-x0}" height="${y1-y0}"/>`);

  const html=`<svg class="tr-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet"
      role="img" tabindex="0" aria-label="${esc(title||'趋势')}">${parts.join('')}</svg>`;
  return {html, geom};
}

/** 悬停/键盘读数：一次给出该期**所有**来源的值，指针不必落在某条线上。 */
function wire(box, geom, t, fmt){
  const svg=box.querySelector('svg'); if(!svg||!geom) return;
  const cross=svg.querySelector('.tr-cross'), hl=svg.querySelector('.tr-hl');
  const tip=box.querySelector('.tr-tip');
  let cur=-1;
  const show=i=>{
    if(i<0||i>=t.dates.length) return;
    cur=i;
    const x=geom.x[i];
    cross.setAttribute('x1',x); cross.setAttribute('x2',x); cross.style.display='';
    hl.innerHTML='';
    for(const s of geom.series){
      const p=s.pts[i]; if(!p) continue;
      const c=document.createElementNS('http://www.w3.org/2000/svg','circle');
      c.setAttribute('cx',p.x); c.setAttribute('cy',p.y); c.setAttribute('r',5.5);
      c.setAttribute('class','tr-hit-dot'); c.style.fill=s.col;
      hl.appendChild(c);
    }
    // 名字来自源表，一律 textContent —— 不拼 HTML
    tip.textContent='';
    const head=document.createElement('div'); head.className='tr-tip-h';
    head.textContent=String(t.dates[i])+(t.partial[i]?'（未走完）':'');
    tip.appendChild(head);
    for(const s of geom.series){
      const p=s.pts[i];
      const row=document.createElement('div'); row.className='tr-tip-r';
      const key=document.createElement('i'); key.style.background=s.col; row.appendChild(key);
      const nm=document.createElement('span'); nm.className='n'; nm.textContent=s.src; row.appendChild(nm);
      const v=document.createElement('b'); v.textContent=p?fmt(p.v):'—'; row.appendChild(v);
      const po=s.po[i];
      const q=document.createElement('span'); q.className='q';
      q.textContent=(po==null?'':Math.round(po).toLocaleString()+' 单'); row.appendChild(q);
      tip.appendChild(row);
    }
    tip.hidden=false;
    // tooltip 贴着十字线走，靠右时翻到左边，别被卡片裁掉
    const r=svg.getBoundingClientRect(), px=x/geom.w*r.width;
    tip.style.left=Math.max(4, Math.min(r.width-tip.offsetWidth-4, px+12))+'px';
    tip.style.top='6px';
  };
  const hide=()=>{ cross.style.display='none'; hl.innerHTML=''; tip.hidden=true; cur=-1; };
  const at=ev=>{
    const r=svg.getBoundingClientRect();
    const vx=(ev.clientX-r.left)/r.width*geom.w;
    let best=0, bd=Infinity;
    geom.x.forEach((x,i)=>{ const d=Math.abs(x-vx); if(d<bd){ bd=d; best=i; } });
    show(best);
  };
  svg.addEventListener('pointermove', at);
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', ()=>show(cur<0?t.dates.length-1:cur));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', e=>{
    if(e.key==='ArrowRight'){ show(Math.min(t.dates.length-1,(cur<0?t.dates.length-1:cur)+1)); e.preventDefault(); }
    else if(e.key==='ArrowLeft'){ show(Math.max(0,(cur<0?t.dates.length-1:cur)-1)); e.preventDefault(); }
    else if(e.key==='Escape') hide();
  });
}

/** 数据表：tooltip 只是「更快」，不是「唯一」—— 每个数在这里都拿得到。 */
function tableView(t){
  const head=['期次','来源',...t.measures.map(m=>m.label),'PO单数'];
  const rows=[];
  t.dates.forEach((d,i)=>{
    for(const s of t.sources){
      const cells=[esc(d)+(t.partial[i]?' *':''), esc(s),
        ...t.measures.map(m=>{ const v=(t.series[m.key][s]||[])[i]; return v==null?'—':pct(v); }),
        t.po[s] && t.po[s][i]!=null ? Math.round(t.po[s][i]).toLocaleString() : '—'];
      rows.push(`<tr>${cells.map(c=>`<td>${c}</td>`).join('')}</tr>`);
    }
  });
  return `<details class="tr-tbl"><summary class="hint">数据表（${rows.length} 行）</summary>
    <div class="tbl-wrap"><table><thead><tr>${head.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody></table></div></details>`;
}

function renderTrend(){
  const host=$('#trend'); if(!host) return;
  const t=state.data && state.data.trend;
  if(!t || !t.sources.length || t.dates.length<2){
    host.innerHTML = t && t.dates.length===1
      ? `<div class="card pad"><div class="sec-title">多期趋势</div>
         <div class="empty">这份报表里${esc(P().key)}只有 1 期，趋势至少要两期。</div></div>`
      : '';
    return;
  }
  const P_=P();
  /* viewBox 的尺寸**贴着真实渲染宽度挑**（宽屏下卡片内宽 ≈1160，小图两列 ≈570）。
     viewBox 会连字号一起缩放 —— 第一版取 760，实际拉到 1400px 宽，
     11px 的轴标签渲染出来 20px，整张图像放大了看。 */
  const main=lineChart(t,'overall',{w:1160,h:300,padL:52,padR:150,padT:16,padB:32,dots:true,endLabels:true,title:'整体成功率'});
  const smalls=t.measures.slice(1).map(m=>({m, c:lineChart(t,m.key,{w:570,h:195,padL:48,padR:26,padT:14,padB:28,dots:true,title:m.label})}));

  const legend=t.sources.map(s=>
    `<span class="tr-lg"><i style="background:${colorOf(s)}"></i>${esc(s)}</span>`).join('');
  const anyPartial=t.partial.some(Boolean);

  host.innerHTML=`<div class="card pad">
    <div class="sec-title">多期趋势 <span class="hint" style="font-weight:400">最近 ${t.dates.length} 期${esc(P_.key)}
      · 每期只掉一点点、任何阈值都不会触发的那类问题只有在这里看得见</span></div>
    <div class="tr-legend">${legend}</div>
    <div class="tr-box" data-key="overall">
      <div class="tr-cap">整体成功率<span class="hint"> · 四个大环节累乘，和上面的 KPI 同一口径</span></div>
      ${main.html}<div class="tr-tip" hidden></div>
    </div>
    <div class="tr-grid-sm">${smalls.map(s=>`
      <div class="tr-box" data-key="${esc(s.m.key)}">
        <div class="tr-cap">${esc(s.m.label)}</div>
        ${s.c.html}<div class="tr-tip" hidden></div>
      </div>`).join('')}</div>
    ${anyPartial?`<div class="hint" style="margin-top:8px">* 标星的那一期还没走完（窗口结束日晚于报表里最新的日报），
      单量天生偏低、比率也未必稳 —— 虚线段就是它，别当成开始掉了。</div>`:''}
    <div class="hint" style="margin-top:6px">纵轴按各图自己的数据范围取整齐刻度，<b>不从 0 起</b> ——
      折线看的是变化幅度，从 0 起会把 0.1pt 的抖动压成一条直线；跨图比高低要看刻度。</div>
    ${tableView(t)}
  </div>`;

  const boxes=[...host.querySelectorAll('.tr-box')];
  if(boxes[0]) wire(boxes[0], main.geom, t, pct);
  smalls.forEach((s,i)=>{ if(boxes[i+1]) wire(boxes[i+1], s.c.geom, t, pct); });
}

export { colorOf, domainOf, lineChart, niceStep, renderTrend, tickLabel, wire };
