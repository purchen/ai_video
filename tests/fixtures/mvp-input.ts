import { scriptDocumentSchema, scriptSectionOrder } from '../../src/domain/schemas';

export const fixtureDate = '2026-09-04T00:00:00.000Z';
export const fixtureSource = {
  schemaVersion: 1 as const, id: 'synthetic-diary', url: 'https://example.invalid/synthetic-test-diary',
  title: '合成测试数据：两晚的原创虚构日记', publisher: '合成测试数据（非新闻）',
  summary: '原创虚构例子：第一晚列十项任务只完成两项；第二晚只选一项并记录下一步。不是采访、统计或真实人物经历。',
  sourceType: 'primary' as const, evidenceWeight: 'high' as const, capturedAt: fixtureDate,
  claim: { key: 'fictional-diary', value: 'affirmed' as const, text: '本测试虚构日记第一晚列十项任务完成两项，第二晚只选一项并记录下一步。' },
};

export const fixtureScript = scriptDocumentSchema.parse({
  schemaVersion: 1, id: 'mvp-life-attitude', projectId: 'mvp-project',
  title: '原创思考样片：今天没做完，就算失败吗？',
  sections: scriptSectionOrder.map((type, index) => ({ type, sentenceIds: [`s${index + 1}a`, `s${index + 1}b`], lenses: [] })),
  sentences: [
    ['今天没做完，就算失败吗？这是一条原创思考测试样片，旁白由系统合成，例子完全虚构。', 'hook'],
    ['你有没有在睡前翻开清单，只看见没打勾的事情，却忘了自己已经往前走了几步？', 'opinion'],
    ['在这份合成测试日记里，第一晚列了十项任务，只完成两项，写下的评价却是今天毫无进展。', 'fact'],
    ['第二晚，虚构的记录者只选一件最重要的小事，完成之后，再写下明天可以接着做的下一步。', 'fact'],
    ['这个例子不能证明少做事一定更好，也不是对所有人的生活给出统一答案。', 'opinion'],
    ['它只是把一个问题摆在眼前：我们究竟在衡量真实的进展，还是在惩罚没有实现的计划？', 'opinion'],
    ['我的理解是，清单本来应该帮助选择；如果每一项都同样重要，选择反而被推回给了焦虑。', 'opinion'],
    ['不妨把任务写得更具体：不是今晚改变人生，而是读完两页，整理一份材料，或者把一个问题问清楚。', 'opinion'],
    ['当然，有些期限不能推迟，有些责任也不能靠一句放轻松就消失。', 'opinion'],
    ['如果有紧急任务，先看影响和期限，再决定顺序；需要帮助时，可以把困难讲清楚，而不是独自硬撑。', 'opinion'],
    ['所以我更愿意把一天的复盘分成两栏：一栏记录做成了什么，一栏留下下一步。', 'opinion'],
    ['没有完成的事情仍然值得处理，但它不必变成对整个人的否定；休息，也可以是认真安排的一部分。', 'opinion'],
    ['今晚，你能不能先承认一件已经做好的小事，再选出明天最想推进的一步？', 'call-to-action'],
    ['这不是效率竞赛，也不是成功秘诀，只是给普通的一天，留下一种更诚实的评价方式。', 'opinion'],
  ].map(([text, type], index) => ({ id: `s${Math.floor(index / 2) + 1}${index % 2 === 0 ? 'a' : 'b'}`, text, type, sourceIds: type === 'fact' ? ['synthetic-diary'] : [], ...(type === 'fact' ? { attribution: '合成测试数据（非新闻）' } : {}) })),
  estimatedDurationMs: 110000, createdAt: fixtureDate, updatedAt: fixtureDate,
});
