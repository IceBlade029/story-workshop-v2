/**
 * marker.test.ts — 暂不明示标记解析与确定性移除（§6.1、§6.3、§11.4）。
 * 覆盖：基本移除、多标记、空标记、未闭合、嵌套（不支持）、跨行、边界。
 */
import { describe, it, expect } from 'vitest';
import { findDisclosureMarkers, stripDisclosureMarkers } from '../../storage/marker';

describe('stripDisclosureMarkers — 确定性机械移除', () => {
  it('移除单个标记区间，不做润色', () => {
    expect(stripDisclosureMarkers('陈默（{{暂不明示：陈默是凶手}}）约林静见面。'))
      .toBe('陈默（）约林静见面。');
  });

  it('无标记时返回原文本（同一引用）', () => {
    const text = '普通细纲，没有标记。';
    expect(stripDisclosureMarkers(text)).toBe(text);
  });

  it('多个标记全部移除', () => {
    expect(stripDisclosureMarkers('A{{暂不明示：x}}B{{暂不明示：y}}C')).toBe('ABC');
  });

  it('空内容标记整段移除（不留空格）', () => {
    expect(stripDisclosureMarkers('甲{{暂不明示：}}乙')).toBe('甲乙');
  });

  it('未闭合标记视为普通文本保留', () => {
    const text = '含未闭合 {{暂不明示：没有闭合的内容';
    expect(stripDisclosureMarkers(text)).toBe(text);
  });

  it('未闭合标记后的闭合符不产生区间', () => {
    expect(stripDisclosureMarkers('a{{暂不明示：b}}c}}d')).toBe('ac}}d');
  });

  it('不支持嵌套：第一个闭合符结束区间，剩余保留', () => {
    expect(stripDisclosureMarkers('{{暂不明示：外层{{暂不明示：内层}}残}}')).toBe('残}}');
  });

  it('跨行标记区间整体移除', () => {
    expect(stripDisclosureMarkers('第一行\n{{暂不明示：隐藏\n两行的秘密}}\n第三行')).toBe('第一行\n\n第三行');
  });

  it('标记位于文本开头与结尾', () => {
    expect(stripDisclosureMarkers('{{暂不明示：开头}}正文')).toBe('正文');
    expect(stripDisclosureMarkers('正文{{暂不明示：结尾}}')).toBe('正文');
  });

  it('相邻标记（中间无文本）', () => {
    expect(stripDisclosureMarkers('{{暂不明示：a}}{{暂不明示：b}}')).toBe('');
  });
});

describe('findDisclosureMarkers — 区间与文本', () => {
  it('返回标记内容与起止下标', () => {
    const spans = findDisclosureMarkers('x{{暂不明示：陈默是凶手}}y');
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 1, end: 15, text: '陈默是凶手' });
  });

  it('提取多个标记的文本', () => {
    const spans = findDisclosureMarkers('{{暂不明示：一}}{{暂不明示：二}}');
    expect(spans.map((s) => s.text)).toEqual(['一', '二']);
  });

  it('无标记返回空数组', () => {
    expect(findDisclosureMarkers('plain')).toEqual([]);
  });

  it('未闭合返回空数组', () => {
    expect(findDisclosureMarkers('{{暂不明示：未闭合')).toEqual([]);
  });
});
