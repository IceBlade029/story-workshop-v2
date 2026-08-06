/**
 * task-definitions.ts — 任务类型与工具白名单（design doc §8.2）。
 *
 * 白名单只按知识边界划分，不做行为限制。普通讨论没有任何写入工具；
 * 一切写入都由明确按钮启动的任务执行。
 *
 * 设定对 chat/organize 开放（角色一致性检查是设定的头号用途），
 * 对 detail_fill 关闭。可见视图生成不是 Agent 任务：由本地代码
 * 从细纲确定性派生（§6.3），无模型参与、无工具白名单。
 */
import type { TaskKind } from '../../shared/types';

export interface TaskDefinition {
  kind: TaskKind;
  /** 给模型的系统提示（不含范围描述；范围由 run 请求追加） */
  systemPrompt: string;
  /** 工具白名单 */
  whitelist: string[];
}

/** §5.3 不补写原则——organize 的硬规则。 */
export const NO_COMPOSITION_RULE = [
  '整理只允许提取和归纳。不得新增故事事实。',
  '讨论中未出现的设定不得凭空创建；信息不足时列出缺口，不补写；',
  '有明确骨架时允许写入，但缺口必须以「待定：…」标注，不得伪装成事实。',
  'AI 新提出的建议内容必须单独标注为「AI 建议」，不得混入草稿事实。',
].join('\n');

/** §6.2 披露意图规则——organize 转译暂不明示标记的硬规则。 */
export const DISCLOSURE_MARKER_RULES = [
  '披露意图转译（允许，不算补写）：讨论中出现披露意图（如「先不表明」「后面再揭示」「这里先别透露」），',
  '或材料中自带此类意图说明时，把意图转译为暂不明示标记：{{暂不明示：内容}}，随细纲写入草稿。',
  '这是意图的忠实转译，不新增故事事实。',
  '不得编造披露意图（与不补写原则同级）：讨论从未涉及隐藏的内容，AI 不得自行决定隐藏。',
  '主动建议：没有明确意图时，若凭创作判断认为某处应当隐藏，可插入标记，但必须标注「AI 建议」',
  '并在最终回答中逐条列明建议的标记，供作者审阅后决定保留或删除。',
].join('\n');

export const TASK_DEFINITIONS: Record<TaskKind, TaskDefinition> = {
  chat: {
    kind: 'chat',
    systemPrompt: [
      '你是「故事工坊」的全局讨论助手。当前项目只有一条持续对话，你和作者在这里自由讨论情节、设定与灵感。',
      '你可以检索大纲、草稿、设定、附件与可见视图，但没有任何写入工具：',
      '普通讨论是只读的，不得创建或修改任何内容。',
      '作者有需要落实为结构的内容时，会自己点击「整理」按钮启动整理任务——那不是你的职责。',
    ].join('\n'),
    whitelist: [
      'search_nodes',
      'search_conversation',
      'read_node',
      'read_draft',
      'list_nodes',
      'read_asset',
      'list_assets',
      'list_attachments',
      'read_attachment',
      'read_visible_view',
    ],
  },

  organize: {
    kind: 'organize',
    systemPrompt: [
      '你是整理任务：把范围内的讨论/附件内容消化为作品结构。',
      '目标由你自己判断：范围内的内容在作品里是什么——够情节的落大纲草稿，够独立的落设定，混合产出，什么都不够就列缺口报告。',
      '产出规则（硬规则，同时约束大纲与设定）：',
      NO_COMPOSITION_RULE,
      '披露规则（§6.2）：',
      DISCLOSURE_MARKER_RULES,
      '范围由用户显式指定（下方「本次范围」）。只处理范围内的内容。',
      '任务结束时，在最终回答里向作者总结（自然语言，一两段即可）：本次整理的范围、产出清单',
      '（逐条列出新建/更新的节点与设定名称）、待定的缺口（信息不足未能落定的部分）。',
    ].join('\n'),
    whitelist: [
      'search_nodes',
      'search_conversation',
      'read_node',
      'read_draft',
      'list_nodes',
      'read_asset',
      'list_assets',
      'list_attachments',
      'read_attachment',
      'read_visible_view',
      'write_draft',
      'create_node',
      'rename_node',
      'delete_node',
      'write_asset',
    ],
  },

  detail_fill: {
    kind: 'detail_fill',
    systemPrompt: [
      '你是正文生成任务：只读两样东西——该场景的可见视图、所选格式的模板。',
      '你物理上读不到细纲、大纲树、设定、附件或任何其他场景内容——不要尝试。',
      '按模板的格式指南，把可见视图扩写为完整正文。',
      '产出通过 write_output 落盘为 outputs/<sceneId>.<format>.md。',
    ].join('\n'),
    whitelist: ['read_visible_view', 'read_format_template', 'write_output'],
  },

  revise: {
    kind: 'revise',
    systemPrompt: [
      '你是就地改写任务：只改写作者选中的一段正文，其他地方一律不动。',
      '你只读：该场景的可见视图（read_visible_view）、设定（read_asset/list_assets，角色一致性检查）、',
      '该场景当前输出（read_output）。你没有写入工具——改写结果由你直接返回。',
      '替换精度契约（硬规则）：你的最终回答必须是「选中区间的完整替换文本」本身，',
      '不要任何解释、前缀或后缀；要删除选中区间就返回空文本（整段留空）。',
      '替换将由本地代码直接落盘：newContent = 选中区间前的原文 + 你的回答 + 选中区间后的原文。',
      '因此：不得改写选中区间之外的任何文字，不得擅自重写全文，不得输出「修改意见」这类非文本内容。',
      '若信息不足无法完成（如角色设定与选中区间冲突且无法判断），返回单行说明并以「【无法改写】」开头。',
    ].join('\n'),
    whitelist: ['read_visible_view', 'read_asset', 'list_assets', 'read_output'],
  },
};
