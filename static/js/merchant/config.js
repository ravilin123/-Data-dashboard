import { AMOUNT_LABELS } from './amount.js';

/* ============================================================
   配置（对应 Python 的 config.py）

   从 `merchant.html` 拆出来（2026-09-09）。金额分档的两套常量和运行时状态
   搬去了 `amount.js`（它带可变状态，见那边的说明）；状态归类搬去了 `util.js`
   （`aggregate` 要用它）。剩下的就是纯配置：列映射、维度注册表、各种阈值。

   ⚠️ 维度注册表里 `dimRows` / `dimAvail` / `dimTable` **不在这里** ——
   它们要 `withDim`（清洗层）和 `generateGroupedTable`（表层），
   放这儿会让配置反过来依赖上面两层。它们在 `tables.js`。
   ============================================================ */

const COLUMN_MAP = {
  "交易单号":"order_id","商户号":"merchant_id","商户名称":"merchant_name","交易币种":"currency",
  "交易金额":"amount","支付方式":"payment_method","流水单状态":"status",
  // 失败原因：兼容新旧格式。旧版单列「支付失败原因」；新版拆成「初始失败原因」(干净文字)
  // +「报错编码」+「失败原因报错」(带【编码】)。清洗时按优先级合成 fail_reason，并保留 fail_code。
  "支付失败原因":"fail_reason_old","初始失败原因":"fail_reason_init","失败原因报错":"fail_reason_full",
  "报错编码":"fail_code","初始失败原因编码":"fail_code2",
  "通道":"channel",
  "支付时间":"pay_time","备案网址":"website","支付卡bin国家":"bin_country","是否3D交易":"is_3ds",
  "风控3DS决策":"risk_3ds","政策3DS决策":"policy_3ds","商户3ds决策":"merchant_3ds",
  // 买家维度。有这几列才谈得上「买家结构有没有偏移」——
  // 同一个 BIN 放量，对应少量卡+少量邮箱是卡测试，大量卡+大量邮箱是渠道投放涌入，
  // 性质完全相反，而只看 BIN 占比这两者长得一模一样。
  // 订单口径三件套。没有 支付单号 就只能算笔数通过率 ——
  // 而两者在真实数据上差 12.42pp（72.90% vs 85.29%），差额全是重试挽回的单。
  "支付单号":"po_id","支付单状态":"po_status",
  // 掩码卡号 53552212******7850：前 6 位是 BIN，整串可区分不同卡。
  // 有它才判得了「同一个 BIN 是一张卡刷很多次（卡测试）还是很多张卡（渠道涌入）」
  "付款银行账号":"card_no",
  "买家邮箱":"buyer_email","邮箱":"buyer_email",
  "买家ip":"buyer_ip","买家IP":"buyer_ip",
  "买家IP国家":"ip_country","IP国家":"ip_country","买家ip国家":"ip_country",
  "收货国家":"ship_country","卡组":"card_brand","卡组织":"card_brand",
};

// 派生字段：不来自源表，由清洗阶段算出。分组时要放行，见 generateGroupedTable
const DERIVED_COLS = new Set(["amount_range","day"]);

/* 维度注册表。维度的「身份」原先散在三处各写一遍：维度页手列 4 个、
   完整分析里 13 处 generateGroupedTable 各自带着中文标签、DIM_LABEL 又抄一份简称。
   同一个维度的标签在三处不一致时，页面上叫「BIN国家」、导出的表叫「支付卡BIN国家」、
   筛选条又叫另一个名字，看的人以为是三个东西。这里统一成一份。

   字段：
     label  完整标签，出现在表头和导出
     short  简称，交叉表命名用（BINx金额 这种）
     tab    是否出现在「维度拆解」页的下拉里
     cats   分类种子（返回函数是因为 AMOUNT_LABELS 会被 buildAmountScheme 换掉）
     scope  取数作用域。card = 只在卡支付内部算（钱包没有卡BIN，混进来比的是
            钱包 vs 卡，不是国家差异，详见 withDim 上方注释）
   交叉表怎么两两配对不写在这里 —— 那要复用已经算好的单维表，接线是显式的。 */
const DIMENSIONS = [
  {col:"payment_method", label:"支付方式",        short:"方式", tab:true},
  {col:"amount_range",   label:"交易金额区间",     short:"金额", tab:true, cats:()=>AMOUNT_LABELS},
  {col:"bin_country",    label:"支付卡BIN国家",    short:"BIN",  tab:true, scope:"card"},
  {col:"ip_country",     label:"买家IP国家",       short:"IP",   tab:true},
  {col:"channel",        label:"通道（收单机构）",  short:"通道", tab:true},
  {col:"ship_country",   label:"收货国家",         short:"收货"},
  {col:"card_brand",     label:"卡组",             short:"卡组"},
  {col:"day",            label:"日期",             short:"日"},
  {col:"fail_reason",    label:"失败原因",         short:"失败"},
];
const DIM = Object.fromEntries(DIMENSIONS.map(d=>[d.col,d]));
const dimLabel = col => (DIM[col] ? DIM[col].label : col);
const dimCats  = col => (DIM[col] && DIM[col].cats ? DIM[col].cats() : null);

const DRILL_DOWN_TOP_N = 3;

// 失败编码口径（按业务定义）：
// 3DS 验证失败（风控/政策侧发起）编码：
const CODE_3DS_FAIL = ["MN3DSFAIL","MN3DSFAILB","ZF3D00001","ZF3D00002","ZF3D00003","ZF3D00004"];
// 风控拦截编码：
const CODE_RISK_BLOCK = ["ZFFK00001","ZFFK00002","ZFFK00003","ZFFK00004","ZFFK00005","ZFFK00006"];
// 「排除风控拦截」开关：命中这些即视为平台风控拦截（含旧版文字，向后兼容）
const RISK_BLOCK_KEYWORDS = [...CODE_RISK_BLOCK, "风控系统拦截", "风控拦截"];
// L3 排除（纯网关层视图）：3DS验证失败 + 风控拦截 都排除
const L3_FAIL_KEYWORDS = [...CODE_3DS_FAIL, ...CODE_RISK_BLOCK, "风控系统拦截", "风控拦截"];
// 保留名单：通道(网关)层发起的，即使含 3DS 也不排除。ZFWG = 通道发起的 3DS 验证失败。
const L3_KEEP_KEYWORDS = ["ZFWG"];

const ANOMALY_RATE_DROP_WARN = -10;
const ANOMALY_RATE_DROP_URGENT = -20;
const ANOMALY_MIN_SHARE = 5;
const ANOMALY_BELOW_OVERALL_PCT = 15;
const ANOMALY_MIN_SHARE_SINGLE = 5;
const ANOMALY_LOW_RATE_ABS = 30;
const ANOMALY_MIN_SHARE_ABS = 3;

export { ANOMALY_BELOW_OVERALL_PCT, ANOMALY_LOW_RATE_ABS, ANOMALY_MIN_SHARE,
         ANOMALY_MIN_SHARE_ABS, ANOMALY_MIN_SHARE_SINGLE, ANOMALY_RATE_DROP_URGENT,
         ANOMALY_RATE_DROP_WARN, CODE_3DS_FAIL, CODE_RISK_BLOCK, COLUMN_MAP,
         DERIVED_COLS, DIM, DIMENSIONS, DRILL_DOWN_TOP_N, L3_FAIL_KEYWORDS,
         L3_KEEP_KEYWORDS, RISK_BLOCK_KEYWORDS, dimCats, dimLabel };
