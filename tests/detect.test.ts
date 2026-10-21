import { describe, it, expect } from 'vitest';
import { scriptRatio, isTargetLanguage, scriptOfLang, isHanLanguage } from '../src/core/detect.js';

describe('scriptRatio', () => {
  it('统计中文', () => {
    const r = scriptRatio('这是一段中文文本');
    expect(r.find(s => s.script === 'han')!.ratio).toBeGreaterThan(0.9);
  });

  it('统计英文', () => {
    const r = scriptRatio('This is an English sentence.');
    expect(r.find(s => s.script === 'latin')!.ratio).toBeGreaterThan(0.8);
  });

  it('区分日语假名和汉字', () => {
    const r = scriptRatio('これはテストです');
    expect(r.find(s => s.script === 'kana')!.ratio).toBeGreaterThan(0.8);
  });

  it('统计韩文', () => {
    const r = scriptRatio('안녕하세요');
    expect(r.find(s => s.script === 'hangul')!.ratio).toBeGreaterThan(0.8);
  });

  it('统计西里尔字母', () => {
    const r = scriptRatio('Это тестовый текст на русском языке');
    expect(r.find(s => s.script === 'cyrillic')!.ratio).toBeGreaterThan(0.8);
  });

  it('忽略标点和数字', () => {
    const r = scriptRatio('123 !@# 456');
    expect(r.length).toBe(0);
  });

  it('空字符串返回空数组', () => {
    expect(scriptRatio('')).toEqual([]);
  });
});

describe('scriptOfLang', () => {
  it('语言代码映射到书写系统', () => {
    expect(scriptOfLang('zh')).toBe('han');
    expect(scriptOfLang('zh-CN')).toBe('han');
    expect(scriptOfLang('ja')).toBe('kana');
    expect(scriptOfLang('ko')).toBe('hangul');
    expect(scriptOfLang('ru')).toBe('cyrillic');
    expect(scriptOfLang('en')).toBe('latin');
    expect(scriptOfLang('de')).toBe('latin');
  });
});

describe('isHanLanguage', () => {
  it('汉字系语言', () => {
    expect(isHanLanguage('zh')).toBe(true);
    expect(isHanLanguage('zh-Hant')).toBe(true);
    expect(isHanLanguage('ja')).toBe(true);
    expect(isHanLanguage('ko')).toBe(true);
    expect(isHanLanguage('en')).toBe(false);
  });
});

describe('isTargetLanguage', () => {
  const zh = '这是一段完整的中文网页正文，用来测试语言判断是否准确。';
  const en = 'This is a complete English paragraph of web page text used for testing.';
  const ja = 'これは日本語のテキストです。テストのために書いています。';
  const ko = '이것은 한국어 텍스트입니다. 테스트를 위해 작성했습니다.';
  const ru = 'Это полный текст на русском языке для проверки определения языка.';

  it('中文页面 → 目标语言是中文时判为是', () => {
    expect(isTargetLanguage(zh, '简体中文')).toBe(true);
    expect(isTargetLanguage(zh, '繁體中文')).toBe(true);
  });

  it('英文页面 → 目标语言是中文时判为否', () => {
    expect(isTargetLanguage(en, '简体中文')).toBe(false);
  });

  it('目标语言是英文时', () => {
    expect(isTargetLanguage(en, 'English')).toBe(true);
    expect(isTargetLanguage(zh, 'English')).toBe(false);
  });

  it('目标语言是日文时', () => {
    expect(isTargetLanguage(ja, '日本語')).toBe(true);
    expect(isTargetLanguage(zh, '日本語')).toBe(false);
  });

  it('目标语言是韩文时', () => {
    expect(isTargetLanguage(ko, '한국어')).toBe(true);
    expect(isTargetLanguage(zh, '한국어')).toBe(false);
  });

  it('目标语言是俄文时', () => {
    expect(isTargetLanguage(ru, 'Русский')).toBe(true);
    expect(isTargetLanguage(en, 'Русский')).toBe(false);
  });

  it('html lang 明确说是别的语言，直接判否', () => {
    expect(isTargetLanguage(en, '简体中文', 'en')).toBe(false);
    expect(isTargetLanguage(en, '简体中文', 'en-US')).toBe(false);
  });

  it('html lang 说是目标语言，判是', () => {
    expect(isTargetLanguage(zh, '简体中文', 'zh-CN')).toBe(true);
    expect(isTargetLanguage(en, 'English', 'en')).toBe(true);
  });

  it('html lang 是 und / 空，不影响文字判断', () => {
    expect(isTargetLanguage(zh, '简体中文', 'und')).toBe(true);
    expect(isTargetLanguage(zh, '简体中文', '')).toBe(true);
  });

  it('没有文字时判为是（不打扰用户）', () => {
    expect(isTargetLanguage('', '简体中文')).toBe(true);
  });

  it('中日混排：日语优先', () => {
    const mixed = '这是日语文本。这是 日本語 です。';
    expect(isTargetLanguage(mixed, '日本語')).toBe(true);
  });
});
