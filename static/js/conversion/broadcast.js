import { BROADCAST_MAX_CHARS, BROADCAST_PRIO_TOP, CODE_METRIC, COUNTER_DIR_FLOOR, FRICTION_METRICS, METRIC_CODE, P, SMALL_MERCHANT_PO, WATCH_GAP, WATCH_LOW_RUN, WATCH_MIN_PO, WATCH_TOP } from './config.js';
import { drillMetric, totalPOBySource } from './detect.js';
import { sceneMap } from './funnel.js';
import { shortSite } from '../shared/text.js';
import { ordFmt, pct, ptFmt } from './util.js';

/* ============================================================
   7. 播报素材（对应 broadcast_txt / broadcast_md）
   ============================================================ */
function uniq(a){ return [...new Set(a)]; }
/** 播报抬头：结论先行——总成功率 + 最该先排查的环节 + 是哪几家商户在拖。 */
/**
 * @param ctx 本次分析结果（AnalysisResult），要用的是
 *            `mergedSite / dfScene / tDate / yDate`。**由调用方传入，不再读 store**（T3）。
 */
function headlineLines(stages, alarms, tDate, srcStory, ctx){
  const P_=P(), L=[];

  /* 商户名去掉打码尾巴：「速飛*******司」→「速飛」。
     星号既区分不了商户也占着最宽的位置 —— 这份数据里「香港*********司」对应 15 个
     不同用户ID，完整写出来一样分不开，真要区分靠的是后面那个站点。 */
  const shortMerchant=n=>{ const s=String(n||''), i=s.indexOf('*'); return i>0 ? s.slice(0,i) : s; };

  const d0 = ctx || null;
  const totalPO = d0 ? totalPOBySource(d0.mergedSite) : {};
  // 子环节没触发告警时也要写出它的两期值来撑住层级，所以要能查任意指标的比率
  const mapT = d0 ? sceneMap(d0.dfScene, d0.tDate) : {};
  const mapY = d0 ? sceneMap(d0.dfScene, d0.yDate) : {};

  // alarms 是 alarmTotal + alarmSite 拼起来的，同一条场景指标会出现两次，按 来源→指标 索引即去重
  const byMetric={};
  for(const a of (alarms||[])) (byMetric[a['来源']]=byMetric[a['来源']]||{})[a['异常指标']]=a;

  /* 三态只留 局部 和 未解释：根因/已解释 在树形结构里是自明的 ——
     挂在最深处的就是根因，上面还有更深告警的就是已解释，再标一遍是废话。
     局部（所属大环节其实没事）和未解释（子指标都正常、另有原因）
     这两个结构表达不出来，得留着。 */
  /* 群消息里**不解释口径**（用户 2026-09-09 定的）。
     「局部」原来写成「未对主环节造成影响」—— 那是内部术语，而且它回答的是
     「这条要不要管」，树形结构本来就说明白了（挂在哪一层就是哪一层的事），删掉。
     「未解释」留着但换成人话：它说的是「大环节异常、子指标却都正常」，
     这条是要人工去看的，别的地方谁都不说 —— 那不是口径，是发现。
     ⚠️ **「无子指标」不出这句。** 环节2 在漏斗树里没有子指标（`FUNNEL_SUBS['2']=[]`），
     它只要告警就必然落到这一档；说「子指标查不出原因」等于让人去查一批不存在的东西。
     实测两份报表 14 对期次，每一条「未解释」都是环节2 —— 分开之后这句才只在
     真的「有子指标而且都正常」时出现。 */
  const roleTag=a=>(a && a._role==='未解释') ? '，子指标查不出原因' : '';
  const rateTxt=(src,m,a)=>{
    if(a) return `${a['上期比率']}→${a['本期比率']}（${a['环比']}${roleTag(a)}）`;
    const y=(mapY[src]||{})[m], t=(mapT[src]||{})[m];
    return (y!=null&&t!=null) ? `${pct(y)}→${pct(t)}（${ptFmt(t-y)}）` : '（本期无数）';
  };

  /* 这一段里列出来的商户合计折损多少单。用来判「上面几家解释得了本环节的变动吗」——
     解释不了要说出来，否则「本环节减少 87 单」下面挂着一家「减少 1 单」，
     读的人会以为是算错了（其实是各商户占比此消彼长，页面上有那句话，群里以前没有）。 */
  let explained = 0;
  const merchants=(src, metric, dir, pad)=>{
    if(!d0) return [];
    let rows=[];
    try{ rows=drillMetric(d0.mergedSite, src, metric,
                          {isF:FRICTION_METRICS.includes(metric), totalPO:totalPO[src]||0,
                           hasSite:d0.hasSite, dir, stages:(d0.stages||{})[src]})||[]; }
    catch(e){ rows=[]; }
    /* 不足 SMALL_MERCHANT_PO 单的不点名（B12）：3 单里失败 1 单 = 100.00%→33.33%，
       一个 66pt 的变动，真实含义只是「有一单没成」。实测日报那天 42 条下钻里
       17 条不足 50 单 —— 全塞进群消息，真正要看的那家就被淹了。页面上仍然都在。 */
    const big = rows.filter(r=>!r._small);
    const shown = big.slice(0,BROADCAST_PRIO_TOP);
    for(const r of shown) explained += r['影响单量']||0;
    return shown.map(r=>{
      /* 商户名和站点一样时只写一次。新版报表没有「商户名称」列，
         loadMerchant 用站点域名顶上，直接拼会写成「17best.com 17best.com」。 */
      const who=((m,st)=>m&&m!==st?m+' '+st:st)(shortMerchant(r['商户名称']), shortSite(r['站点']));
      // 折损单量在前、比率在后：要的是「少了多少单」，比率只是佐证（B1）
      const ord = r['影响单量']!=null ? `，${ordFmt(r['影响单量'])}` : '';
      return `${pad}${who} PO ${r['本期PO总单量'].toLocaleString()}笔${ord}`
           + `（${r['上期比率']}→${r['本期比率']}）`;
    });
  };
  /* dir 问的是「要恶化的那批商户还是好转的那批」，不是「涨的还是跌的」。
     drillMetric 内部按 isF 把它翻回 delta 的符号：摩擦类涨=坏、通过率类跌=坏。
     所以这里得先判断这次变动对该指标到底是好是坏，只看 _dod 的正负会翻车 ——
     3.2.2 政策3DS交易占比 是摩擦类，涨 7.6% 是恶化，当成 better 传进去
     筛出来的是**跌**的那批商户，播报上就成了「指标在涨、列出的商户全在跌」。
     FRICTION_METRICS 里那四个（3.1.2 / 3.2 / 3.2.1 / 3.2.2）都踩了这个坑。 */
  const dirOf=(a, metric)=>{
    const rose=((a&&a._dod)||0)>0;
    return (FRICTION_METRICS.includes(metric) ? rose : !rose) ? 'worse' : 'better';
  };

  /* 一个大环节下面的树，严格按编号的层级走：子环节 → 孙环节 → 商户。
     编号就是层级，因果自下而上 —— 3.3 是子、3.3.2 是孙，是 3.3.2 把 3.3 带下去的，
     所以先说 3.3 动了，再说是 3.3.2 造成的，商户拆在 3.3.2 上。
     **没有孙环节告警就停在子环节拆商户。**

     子环节自己没触发、但下面有孙环节触发时，照样把它写出来并标「未触发」——
     否则孙环节会直接贴在大环节下面，层级看着是乱的（3.1.2 和 3.2 并排过）。
     同层多个孙环节都触发时各自成行、各自拆商户，不做取舍：
     只留最狠的那个会把兄弟静默吞掉，这正是这次要消灭的毛病。 */
  /* 按编号前缀找下一层，不走 METRIC_CHILDREN。
     环节1 是 1.1×1.2 累乘出来的、没有自己的指标行，CODE_METRIC['1'] 是 undefined，
     顺着父指标找孩子会整棵树落空 —— 1.2 Paynow点击率 就这么丢过一次。 */
  const childrenOf=(code)=>{
    const pre=String(code)+'.', out=[];
    for(const c of Object.keys(CODE_METRIC))
      if(c.startsWith(pre) && c.slice(pre.length).indexOf('.')<0) out.push(CODE_METRIC[c]);
    return out;
  };

  /* 3DS 交易占比那几个（FRICTION_METRICS）不进各环节的树 —— 它们单独成段。
     占比上升说的是「更多单被推去做 3DS 验证」，和「某个环节通过率掉了」是两回事，
     混在同一棵树里读的人会当成同一个原因。它们只在**上升**时才报：
     占比下降是好事，阈值那边本来也只对上升触发（friction_rise）。 */
  const isFric=m=>FRICTION_METRICS.includes(m);

  /* 一棵子树：子环节 → 孙环节 → 商户。pick 决定哪些指标算数
     （各环节树排除 3DS 占比，3DS 段只要 3DS 占比）。
     有孙的节点只当路标不拆商户，商户永远拆在最深那层，避免父子重复列同一批人。 */
  const subTree=(src, code, pick, pad)=>{
    const A=byMetric[src]||{}, lines=[]; let n=0;
    const p1=pad, p2=pad+'   ', p3=pad+'      ';
    for(const kid of childrenOf(code)){
      const kA=A[kid], kOk=kA && pick(kid);
      const grands=childrenOf(METRIC_CODE[kid]||'').filter(g=>A[g] && pick(g))
        .sort((x,y)=>Math.abs(A[y]._dod||0)-Math.abs(A[x]._dod||0));
      if(!kOk && !grands.length) continue;             // 这一支没动静，不占篇幅
      lines.push(`${p1}└ ${kid} ${rateTxt(src,kid,kA)}`);
      if(kOk) n++;
      if(!grands.length){                               // 没有孙 → 就停在子环节做商户分析
        lines.push(...merchants(src, kid, dirOf(kA, kid), p2));
        continue;
      }
      // 多个孙都在动就全列出来，不做取舍 —— 只留最狠的那个会把兄弟静默吞掉
      for(const g of grands){
        lines.push(`${p2}└ ${g} ${rateTxt(src,g,A[g])}`);
        lines.push(...merchants(src, g, dirOf(A[g], g), p3));
        n++;
      }
    }
    return {lines, n};
  };
  const stageTree=(src, code)=>subTree(src, code, m=>!isFric(m), '     ');

  /* 3DS 交易占比段。跨环节收集所有触发的占比指标（3.1.2 挂在 3.1 下、
     3.2.x 挂在 3.2 下），父级即使自己没触发也写出来撑住层级。 */
  const fricTree=(src)=>{
    const A=byMetric[src]||{};
    if(!Object.keys(A).some(m=>isFric(m))) return {lines:[], n:0};
    const lines=[]; let n=0;
    for(const st of ['1','2','3','4']){
      const t=subTree(src, st, isFric, '     ');
      lines.push(...t.lines); n+=t.n;
    }
    return {lines, n};
  };

  /* 来源整个没了（A3）排在所有来源故事**前面**：它比任何单指标波动都大 ——
     下面每一条对比都少了这一块。以前 stageAnalysis 只遍历本期有的来源，
     页面上就是少一张卡、播报里一个字都没有。 */
  const churn = (d0 && d0.churn) || {};
  for(const src of (churn.gone||[]))
    L.push(`⚠️ ${src}｜本期整个没有数据（上期有）—— 先确认是上游没出数，还是这条线停了`);
  for(const src of (churn.appeared||[]))
    L.push(`🆕 ${src}｜本期首次出现，没有${P_.dod}可比`);

  let budget=BROADCAST_MAX_CHARS, dropped=0;
  for(const s of (srcStory||[])){
    const f=(stages||{})[s.src];
    L.push(`■ ${s.src}｜业务单支付成功率 ${pct(s.overallT)}（${P_.dod} ${ptFmt(s.dOverall)}，上期 ${pct(s.overallY)}）`);
    const ss=((f&&f.stages)||[]).filter(x=>x.contrib!=null);
    if(!ss.length) continue;
    // 和整体同向、贡献最大的那个就是「主要来自」；其余按影响绝对值排，重的先说
    const rising = s.dOverall>=0;
    const mainSt = ss.slice().sort((a,b)=> rising ? b.contrib-a.contrib : a.contrib-b.contrib)[0];
    // 反方向拉得最狠的那个 —— 「同期拉升/拖累」讲的就是它，够大才值得说
    const counterSt = ss.slice().sort((a,b)=> rising ? a.contrib-b.contrib : b.contrib-a.contrib)[0];
    const others = ss.filter(x=>x!==mainSt).sort((a,b)=>Math.abs(b.contrib)-Math.abs(a.contrib));

    /* 段落顺序固定：主要问题 → 次要问题（可多条）→ 3DS交易占比上升 → 同期拉升。
       和整体同向的先说完，再说 3DS 占比，最后才说反方向在拉的那个 ——
       否则「哪些是坏消息」会被中间插进来的好消息打断。 */
    const emit=(head, body, cnt, exempt)=>{
      const cost=head.length+1+body.join('\n').length+1;
      /* 字数上限：宁可明说「还有 N 条」，也不要整条消息超长被接口拒掉 ——
         那样是一条都收不到，且失败原因未必看得出是长度。
         主环节豁免：它是「这个来源为什么动」的答案，砍掉就只剩一行光秃秃的抬头，
         比少几条次要告警糟得多。来源就两个，主环节的量有上界。 */
      if(!exempt && cost>budget){ dropped+=Math.max(cnt,1); return; }
      budget-=cost; L.push(head, ...body);
    };
    /* 抬头也带上单量（B1）：「拉低整体 −1.59pt」说了等于没说，看的人还得自己换算成
       单量才知道要不要管。contrib 是该环节对该来源整体成功率的精确贡献（telescoping
       分解，各环节相加恰等于整体变动），乘以该来源 PO 总量就是少了多少支付成功单。 */
    const srcPO = totalPO[s.src]||0;
    /* ⚠️ **涨的时候不能叫「问题」。** 原来是 `↑ 次要问题 环节3 网关提交率 +0.45pt`——
       箭头朝上、写着「拉动」、却叫「次要问题」，读的人要愣一下才反应过来。

       ⚠️ **一个环节别报五个数。** 原来是
         `83.92%→80.95%（−2.97pt，拉低整体 −1.59pt · 支付成功单减少 48 单）`
       五个数里「拉低整体 −1.59pt」在群里没人拿去做二次计算 —— 它的用处是排序，
       而排序结果就摆在眼前（这条排在前面）。真正要读的是「掉了多少 pt」和
       「少了多少单」，原值放到最后括号里备查。 */
    const stageHead=(st, label)=>{
      const up = st.contrib>=0;
      const lab = up ? (label==='主要问题' ? '主要拉动' : label==='次要问题' ? '同期在涨' : label) : label;
      return `  ${up?'↑':'↓'} ${lab} 环节${st.code} ${st.label} `
        + `${ptFmt(st.rateT-st.rateY)}`
        + (srcPO ? `，支付成功单${ordFmt(st.contrib*srcPO)}` : '')
        + `（${pct(st.rateY)}→${pct(st.rateT)}）`;
    };

    /* 「上面几家解释得了这个环节吗」。解释不到四成就把两个数摆出来 ——
       不摆的话，「本环节减少 87 单」下面挂着一家「减少 1 单」，读的人会以为算错了。
       ⚠️ **只给数，不解释差额哪来的**（原来那句「差额来自各商户占比此消彼长，
       以及不足 50 单未点名的小商户」43 个字，一条播报里出现两次）。
       本环节本身不足 5 单时不啰嗦：那点量差多少都不值得解释。 */
    const gapNote=(st, exp)=>{
      const whole = st.contrib*srcPO;
      if(!srcPO || Math.abs(whole) < 5) return null;
      if(Math.abs(exp) >= Math.abs(whole)*0.4) return null;
      return `     （上面几家合计${ordFmt(exp)}，本环节共${ordFmt(whole)}）`;
    };

    // ① 主要问题
    if(mainSt){
      explained=0;
      const t=stageTree(s.src, mainSt.code);
      const body=t.lines.length ? t.lines
        : merchants(s.src, `${mainSt.code}. ${mainSt.label}`, mainSt.contrib>=0?'better':'worse', '     ');
      const note=gapNote(mainSt, explained);
      if(note) body.push(note);
      emit(stageHead(mainSt,'主要问题'), body, t.n, true);
    }
    /* ② 次要问题：**只要环节下面还有触发的告警就报**，有几个说几个。
       不看这个环节自己是涨是跌、贡献够不够大 —— 那两件事决定的是「要不要额外
       给它一行没有告警的上下文」，不该决定它下面的负值报不报。
       踩过：周报里 API直连 环节3 涨了 +0.07pt（反方向、又低于 0.1pt 门槛），
       整段被丢，连带把 3.3.2 政策3DS通过率 −2.1% 这条负值一起吞掉了。 */
    const quiet=[];
    for(const st of others){
      explained=0;
      const t=stageTree(s.src, st.code);
      if(!t.lines.length){ quiet.push(st); continue; }   // 没告警的留到 ④ 再挑
      const note=gapNote(st, explained);
      emit(stageHead(st,'次要问题'), note ? [...t.lines, note] : t.lines, t.n, false);
    }
    // ③ 3DS 交易占比上升，单独一段，不和上面的环节树混在一起
    const fr=fricTree(s.src);
    if(fr.lines.length) emit('  ↑ 3DS交易占比上升', fr.lines, fr.n, false);
    /* ④ 一条告警都没有的环节里，只挑反方向拉得最狠、且够大的那一个说一句
       ——「整体在跌，但这里在拉」是有用的上下文。其余没告警的环节一律略过：
       环节1 拉低 0.19pt、商户比率 100.06%→100.00%，写出来纯是噪声。 */
    for(const st of quiet){
      if(st!==counterSt || (st.contrib>=0)===rising) continue;
      if(Math.abs(st.contrib)<COUNTER_DIR_FLOOR) continue;
      const body=merchants(s.src, `${st.code}. ${st.label}`, st.contrib>=0?'better':'worse', '     ');
      emit(stageHead(st, st.contrib>=0?'同期拉升':'同期拖累'), body, 1, false);
    }
  }
  /* ⚠️ 这里原来有一句「（另有 N 家不足 50 单的商户未点名）」，2026-09-09 删了。
     它是**口径**不是发现：小商户不点名这条规则群里没人会拿去做判断，而它每期都出现。
     口径留在页面上（异常明细里那批本来就都在）。同理下面掉量那段也不再解释门槛。 */

  /* 商户进出（A2）。这两批只在一期出现、算不出环比，挂在任何环节下面都是错的，
     所以单独一段收尾。掉量按上期 PO 倒序 —— 掉一家 3000 单的和掉一家 3 单的
     不是一回事，而内连接对这两种情况一视同仁（都是直接不存在）。
     小尾巴只计数不点名：报表里天天有一堆一天几单的商户进进出出，
     全列出来会把真正要看的那一两家淹掉。
     这一段不走 emit —— 它有上界（最多六七行），而"哪家掉没了"不该因为
     前面的告警太长就被挤掉。 */
  /* 只留掉量。「新增 / 首次有量」那批归另一条消息（待观察商户清单）——
     两件事问的不是同一个问题：掉量是「出事了」，新增是「要盯着」。 */
  const lost=churn.lost||[];
  if(lost.length){
    L.push(`■ 掉量商户｜${lost.length} 家上期有量、本期整个没了，上期共 ${(churn.lostPO||0).toLocaleString()} 单`);
    if(churn.partial)
      L.push(`  ⚠️ 本期还没走完（报表最新到 ${churn.latestDaily}），「掉量」多半只是还没下单`);
    {
      const big=lost.filter(x=>x['PO单数']>=SMALL_MERCHANT_PO);
      for(const x of big.slice(0, BROADCAST_PRIO_TOP))
        L.push(`     ${((m,st)=>m&&m!==st?m+' '+st:st)(shortMerchant(x['商户名称']), shortSite(x['站点']))}`
               + ` ${x['来源']} 上期 ${x['PO单数'].toLocaleString()} 单`);
      /* 只在**真列了行**的时候补一句「另有 N 家未列出」，而且不解释门槛。
         一家都没列出时（全是小尾巴）抬头那行「N 家…上期共 M 单」本身就是完整的，
         再挂一句「另有 N 家未列出」反而像是漏了什么。 */
      const shown=Math.min(big.length, BROADCAST_PRIO_TOP), rest=lost.length-shown;
      if(shown && rest) L.push(`     （另有 ${rest} 家未列出）`);
    }
  }

  /* 水平信号（B3）。放在最后一段：它讲的不是「今天动了多少」而是
     「今天这个数在历史上算什么位置」，两种判据混在同一段里读的人会当成一回事。
     和掉量那段一样不走 emit —— 上界就是两三行，不该被前面的告警挤掉。 */
  L.push(...levelLines(ctx));

  if(dropped) L.push(`（另有 ${dropped} 条告警因篇幅未列出）`);
  return L;
}

/**
 * `■ 水平信号` 段。
 *
 * ⚠️ 措辞要让人一眼看出这**不是环比** —— 「低于历史 P10」「连续 N 期」，
 * 都带上中位数当分母。只写「48.96%」的话，读的人会以为是又一条环比告警，
 * 而这条恰恰是环比一辈子报不出来的那种（实测 2026-09-04 那条环比只有 −1.33%）。
 */
function levelLines(ctx){
  const r=(ctx && ctx.levels) || null;
  if(!r || r.noBaseline) return [];          // 没算基准线就一个字都不写，别在群里解释配置
  const lv=r.level||[], cp=r.creep||[];
  if(!lv.length && !cp.length) return [];
  const L=[''];
  const parts=[];
  if(lv.length) parts.push(`${lv.length} 条跌破历史下沿`);
  if(cp.length) parts.push(`${cp.length} 条连续走低`);
  L.push(`■ 水平信号｜${parts.join('、')}（对比该来源自己的历史分布，不是环比）`);
  /* 带上「回到中位能多成多少单」—— 群里只写 pt 的话没人知道要不要管，
     和 B1/B2 把「环比 −6.2%」换成「减少 210 单」是同一个理由。 */
  const worth=x=>x['影响单量']!=null ? `，回到中位约${ordFmt(x['影响单量'])}` : '';
  for(const x of lv.slice(0, BROADCAST_PRIO_TOP))
    L.push(`     ${x['来源']} ${x['指标']} ${pct(x['本期值'])}，`
         + `${x._isF?'高于':'低于'}历史 ${x._isF?'P90':'P10'} ${pct(x['分位线'])}`
         + `（中位 ${pct(x['中位'])}${worth(x)}）`);
  for(const x of cp.slice(0, BROADCAST_PRIO_TOP))
    L.push(`     ${x['来源']} ${x['指标']} 连续 ${x['连续期数']} ${P_.run}`
         + `${x._isF?'不低于':'不高于'} ${x._isF?'P75':'P25'} ${pct(x['分位线'])}`
         + `（本期 ${pct(x['本期值'])}，中位 ${pct(x['中位'])}${worth(x)}）`);
  const rest=Math.max(0, lv.length-BROADCAST_PRIO_TOP)+Math.max(0, cp.length-BROADCAST_PRIO_TOP);
  if(rest) L.push(`     （另有 ${rest} 条未列出）`);
  return L;
}

/**
 * 根因指标名，去重后按漏斗顺序 —— 播报里用一行带过，不再逐条铺开。
 * 口径必须和 distinctRootCauses() 一致：排除「已解释」，而不是只取「根因」，
 * 否则文案里的数字和后面列出的名字对不上。
 */
/* ============================================================
   待观察商户清单 —— **单独一条消息**（B14）
   ============================================================
   不和转化率监控混在一条里，两个理由：

   1. **两件事**。上面那条讲「今天出了什么事」，这条讲「这几家一直不对劲」。
      读的人、要做的动作、紧急程度都不一样 —— 混在一条里，看的人会把下半截
      当成没修完的告警，然后连上半截一起忽略。
   2. **飞书里会很难看**。一条消息里塞两套结构（环节树 + 三段名单），
      纯文本版缩进层级打架，卡片版更是一大坨 —— 拆成两条各自都短。

   同行水平那行放在最后：它是「低 43pt」的分母，但不是结论，
   放开头会挡住名单本身。
*/
function watchLines(ctx){
  const w=(ctx && ctx.watch) || null;
  if(!w || (!w.low.length && !w.fresh.length && !w.tiny.count && !(w.omPending||[]).length)) return [];
  const P_=P();          // 「连续 N 天／周／个月」的量词跟着当前周期走
  const shortMerchant=n=>{ const s=String(n||''), i=s.indexOf('*'); return i>0 ? s.slice(0,i) : s; };
  const who=(n,s)=>((m,st)=>m&&m!==st?m+' '+st:st)(shortMerchant(n), shortSite(s));
  /* 不写「这不是告警」那种解释句 —— 群消息里没人要读元信息，
     标题【待观察商户】已经把它和上面那条转化率监控分开了。
     解释留在页面卡片上（那是配这套东西的人在看，受众不一样）。 */
  const L=[];

  if(w.low.length){
    /* 「长期低位」几家单独说一句 —— 那批是该找人推的，和「这期才掉的」不是一回事。
       用户的原话：连续 3 个工作日还这样，就该进这份名单。 */
    const longRun=w.low.filter(x=>x.长期低位).length;
    L.push(`■ 明显低于同行 ${w.low.length} 家`
         + (longRun ? `（其中 ${longRun} 家连续 ${WATCH_LOW_RUN} ${P_.run}以上）` : ''));
    for(const x of w.low.slice(0, WATCH_TOP)){
      /* 「量少」标记去掉：每行前面就写着「40单」，再标一次是重复。 */
      const marks=[x.长期低位?`连续${x.连续期数}${P_.run}`:(x.连续期数>=2?`连续2${P_.run}`:''),
                   ...(x.出单监控||[])].filter(Boolean);
      L.push(`   ${who(x.name, x.site)} ${x.src} ${x.po.toLocaleString()}单 ${pct(x.rate)}`
           + `（低 ${(x.缺口*100).toFixed(0)}pt${marks.length?'，'+marks.join('·'):''}）`);
    }
    if(w.low.length>WATCH_TOP) L.push(`   （另有 ${w.low.length-WATCH_TOP} 家未列出）`);
    /* 名单按缺口排（风险），但缺口小、量大的那家钱最多 —— 不单独点一句会被忽略。
       实测周报：ifonetool.com 缺口只有 13pt 排在末尾，7031 单，做到中位数多成 918 单。 */
    if(w.best && w.best.可多成 > 0)
      L.push(`   💰 这批里量最大的是 ${shortSite(w.best.site)}：${w.best.po.toLocaleString()} 单，`
           + `做到同行水平能多成 ${w.best.可多成.toLocaleString()} 单`);
  }
  if(w.fresh.length){
    L.push(`■ 本期首次有量 ${w.fresh.length} 家，先盯几期`);
    for(const f of w.freshNamed.slice(0, WATCH_TOP))
      L.push(`   ${who(f['商户名称'], f['站点'])} ${f['来源']} ${f['PO单数'].toLocaleString()}单`
           + (f['成功率']==null ? '' : ` ${pct(f['成功率'])}`)
           + ((f.出单监控||[]).length ? `（${f.出单监控.join('·')}）` : ''));
    if(w.freshNamed.length>WATCH_TOP)
      L.push(`   （另有 ${w.freshNamed.length-WATCH_TOP} 家未列出）`);
    if(w.freshTiny.count)
      L.push(`   （另 ${w.freshTiny.count} 家量还太少）`);
  }
  /* 出单监控说「刚审核通过、还没出单」的那批（B15）——
     转化率报表里还没有它们的数据，上面两段都装不下，但「在等谁上量」是要说的。 */
  if((w.omPending||[]).length){
    L.push(`■ 刚审核通过、还没出单：${w.omPending.length} 家（出单监控 ${w.omDate} 的名单）`);
    for(const x of w.omPending.slice(0, WATCH_TOP))
      L.push(`   ${who(x['商户名称'], x['站点'])}${x['所属BD']?` BD ${x['所属BD']}`:''}`
           + `${x['通道通过日期']?` 通道通过 ${x['通道通过日期']}`:''}`);
    if(w.omPending.length>WATCH_TOP) L.push(`   （另有 ${w.omPending.length-WATCH_TOP} 家未列出）`);
  }

  if(w.tiny.count)
    L.push(`■ 量太少看不出来 ${w.tiny.count} 家，合计 ${w.tiny.po.toLocaleString()} 单`);

  /* 同行水平这行留着 —— 每条「低 28pt」都是相对它说的，不给基准值那句话就是空的。
     但**括号里的口径全删**：定义（同来源／≥10 单／中位数）和样本量都是页面上的事。
     ⚠️ `b.weak`（够量的同行不足 3 家、退回全量算）也一并不出现在群里了，
     那个数据质量提示现在只有页面上有。 */
  const bl=Object.entries(w.baselines||{})
    .map(([src,b])=>`${src} ${pct(b.rate)}`).join('　·　');
  if(bl) L.push(`同行水平：${bl}`);
  return L;
}

/** 待观察商户 · 群消息版。没人要盯时返回空串，调用方据此决定发不发。 */
function watchTxt(tDate, ctx){
  const L=watchLines(ctx);
  return L.length ? [`【待观察商户 ${tDate}】`, ...L].join('\n') : '';
}
/** 待观察商户 · markdown 版。和上面同一份内容，只是排版。 */
function watchMd(tDate, ctx){
  const L=watchLines(ctx);
  if(!L.length) return '';
  return [`# 待观察商户 ${tDate}`, '',
          ...L.map(x=>x.startsWith('   ') ? '  '+x.trim() : x)].join('\n\n');
}

/**
 * 群消息版播报。
 *
 * 以前是 96 行 / 近 7000 字符，其中 74 行是逐指标逐商户的明细 —— 飞书群里没人看得完，
 * 而这些明细在工作台页面上随时能查。现在只讲一件事：
 * 每个场景涨/跌了多少、主要来自哪个环节、那个环节是哪几家商户造成的。
 *
 * 刻意不写「触发异常 N 项 / M 个根因」那种统计行 —— 它既没说异常是什么，
 * 也没说是谁引起的，读的人拿它没法做任何事；真正可行动的信息就是上面那些商户。
 */
function broadcastTxt(aT,dT,aS,dS,tDate,ctx){
  const P_=P(), d=ctx||{}, stages=d.stages||{};
  const n=aT.length+aS.length;
  const head=`【转化率${P_.unit}报监控 ${tDate}】`;
  const lines=[head];
  lines.push(...headlineLines(stages,[...aT,...aS],tDate,d.srcStory,d));
  if(n===0) lines.push('✅ 大盘平稳，无指标触发告警阈值。');
  return lines.join('\n');
}
/** 卡片模式用的 markdown 版。内容和文本版一致，只是排版 —— 详略级别不再分两套。 */
function broadcastMd(aT,dT,aS,dS,tDate,ctx){
  const P_=P(), d=ctx||{}, stages=d.stages||{};
  const n=aT.length+aS.length;
  const title=`# 转化率${P_.unit}报监控 ${tDate}`;
  const head=headlineLines(stages,[...aT,...aS],tDate,d.srcStory,d)
    .map(x=>x.trim()?(x.startsWith('   ')?'  '+x.trim():x):'').join('\n\n');
  if(n===0) return [title,'',head,'','✅ 大盘平稳，无指标触发告警阈值。'].join('\n');
  return [title,'',head].join('\n');
}


export { broadcastMd, broadcastTxt, levelLines, uniq, watchLines, watchMd, watchTxt };
