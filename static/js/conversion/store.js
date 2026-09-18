// sel：每个周期选中的对比期，null = 跟随最新两期
// ds：readReport(wb) 的产物，整份报表读一次就够，切周期/换日期都不用重读
/* om：出单监控最近一次的分类结果（B15）。main.js 起来时异步取一次，
   取不到就一直是 null —— 名单照样出，只是少几个「刚出单 / 刚审核通过」标签。 */
const state = { wb:null, ds:null, baseline:null, baselineActive:false, sel:{}, om:null };

export { state };
