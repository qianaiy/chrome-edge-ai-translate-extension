/**
 * 页面语言检测
 * ------------------------------------------------------------------
 * 「自动翻译非目标语言页面」需要先判断这个页面是不是目标语言。
 * 判断依据按可靠度排序：
 *   1. <html lang> 属性 —— 站点自己声明的，最准
 *   2. 正文文字的字符构成 —— 抽样统计 CJK / 拉丁 / 西里尔等字符比例
 *
 * 纯函数，不碰 DOM（DOM 版本在 content.js 里）。
 */

/** 语言代码 → 该语言主要的书写系统 */
export type Script =
  | 'han' // 中文、日文、韩文（汉字/假名/谚文）
  | 'kana' // 日文假名
  | 'hangul' // 韩文谚文
  | 'latin' // 拉丁字母（英、德、法、西、越、印尼…）
  | 'cyrillic' // 西里尔字母（俄、乌、保…）
  | 'arabic' // 阿拉伯字母
  | 'hebrew' // 希伯来字母
  | 'devanagari' // 天城文
  | 'thai' // 泰文
  | 'other';

export interface LangSample {
  script: Script;
  ratio: number;
}

/** 从一段文字里统计各书写系统的占比 */
export function scriptRatio(text: string): LangSample[] {
  const s = String(text || '');
  const counts: Record<Script, number> = {
    han: 0,
    kana: 0,
    hangul: 0,
    latin: 0,
    cyrillic: 0,
    arabic: 0,
    hebrew: 0,
    devanagari: 0,
    thai: 0,
    other: 0
  };

  let total = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x41) continue; // 跳过控制字符、标点、数字（< 0x41 = 'A'）
    total++;
    if (c >= 0x4e00 && c <= 0x9fff) counts.han++;
    else if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0xff66 && c <= 0xff9d)) counts.kana++;
    else if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x1100 && c <= 0x11ff)) counts.hangul++;
    else if (
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      (c >= 0xc0 && c <= 0x24f)
    )
      counts.latin++;
    else if (c >= 0x400 && c <= 0x4ff) counts.cyrillic++;
    else if (c >= 0x600 && c <= 0x6ff) counts.arabic++;
    else if (c >= 0x590 && c <= 0x5ff) counts.hebrew++;
    else if (c >= 0x900 && c <= 0x97f) counts.devanagari++;
    else if (c >= 0xe00 && c <= 0xe7f) counts.thai++;
    else counts.other++;
  }

  if (!total) return [];
  return (Object.keys(counts) as Script[])
    .map(k => ({ script: k, ratio: counts[k] / total }))
    .filter(x => x.ratio > 0)
    .sort((a, b) => b.ratio - a.ratio);
}

/** 这个语言是不是「用汉字写」的（日语也用汉字，光看 han 会误判） */
export function isHanLanguage(code: string): boolean {
  const c = String(code || '').toLowerCase();
  if (c === 'zh' || c.startsWith('zh-')) return true;
  if (c === 'ja' || c.startsWith('ja-')) return true;
  if (c === 'ko' || c.startsWith('ko-')) return true;
  return false;
}

/** 语言代码 → 大致的书写系统 */
export function scriptOfLang(code: string): Script {
  const c = String(code || '').toLowerCase().split('-')[0];
  if (c === 'zh' || c === 'ja' || c === 'ko') {
    if (c === 'ja') return 'kana';
    if (c === 'ko') return 'hangul';
    return 'han';
  }
  if (c === 'ru' || c === 'uk' || c === 'bg' || c === 'sr' || c === 'mk' || c === 'be') return 'cyrillic';
  if (c === 'ar' || c === 'fa' || c === 'ur') return 'arabic';
  if (c === 'he' || c === 'iw') return 'hebrew';
  if (c === 'hi' || c === 'ne' || c === 'mr') return 'devanagari';
  if (c === 'th' || c === 'lo' || c === 'my') return 'thai';
  if (c === 'en' || c === 'de' || c === 'fr' || c === 'es' || c === 'pt' || c === 'it' || c === 'nl' ||
      c === 'pl' || c === 'sv' || c === 'da' || c === 'no' || c === 'fi' || c === 'cs' || c === 'tr' ||
      c === 'vi' || c === 'id' || c === 'ms' || c === 'tl' || c === 'ro' || c === 'hu' || c === 'el' ||
      c === 'sw' || c === 'af' || c === 'ca' || c === 'et' || c === 'lv' || c === 'lt' || c === 'sl') {
    return 'latin';
  }
  return 'other';
}

/**
 * 判断一段文字是不是目标语言。
 *
 * @param text      抽样文字
 * @param targetLang 目标语言名（支持「简体中文」「繁體中文」「English」「日本語」…）
 * @param htmlLang  页面 <html lang> 属性（可选，有的话更可信）
 */
export function isTargetLanguage(
  text: string,
  targetLang: string,
  htmlLang?: string | null
): boolean {
  const target = String(targetLang || '').trim();

  /* 目标语言的中文变体要一起认（简体/繁体算同一种） */
  const t = target.toLowerCase();
  const wantZh = /中文|漢語|汉语|chinese|zh/i.test(t);
  const wantJa = /日|japanese|jp/i.test(t);
  const wantKo = /한|韩|韓|korean|ko/i.test(t);
  const wantEn = /英语|英文|english|en\b/i.test(t);
  const wantCyr = /俄|рус|russian|ru\b/i.test(t);

  /* --- 1. 先看 <html lang> --- */
  const hl = String(htmlLang || '').trim().toLowerCase();
  if (hl) {
    const base = hl.split('-')[0];
    if (wantZh && (base === 'zh' || base === 'zh-hans' || base === 'zh-hant' || base === 'zh-cn' || base === 'zh-tw')) {
      return true;
    }
    if (wantJa && base === 'ja') return true;
    if (wantKo && base === 'ko') return true;
    if (wantEn && base === 'en') return true;
    if (wantCyr && base === 'ru') return true;
    /* html lang 明确说了是别的语言，那就不是目标语言 */
    if (base && base !== 'und' && base !== 'zxx') {
      /* 只有在语言代码足够明确时才下结论（'x-foo' 之类的忽略） */
      if (/^[a-z]{2,3}$/.test(base)) {
        const script = scriptOfLang(base);
        /* 目标语言是拉丁字母系，而 html lang 是别的系 —— 肯定不是 */
        if (wantEn && script !== 'latin') return false;
        if (wantCyr && script !== 'cyrillic') return false;
      }
    }
  }

  /* --- 2. 看文字本身 --- */
  const samples = scriptRatio(text);
  if (!samples.length) return true; // 没文字可判断，先当是（不打扰用户）

  const top = samples[0];
  const cjk = samples.find(s => s.script === 'han')?.ratio || 0;
  const kana = samples.find(s => s.script === 'kana')?.ratio || 0;
  const hangul = samples.find(s => s.script === 'hangul')?.ratio || 0;
  const latin = samples.find(s => s.script === 'latin')?.ratio || 0;
  const cyrillic = samples.find(s => s.script === 'cyrillic')?.ratio || 0;

  if (wantZh) {
    /* 简体中文页面：汉字占主导，且没有大量假名（否则是日语） */
    if (kana > 0.05) return false;
    return cjk / (cjk + latin + hangul + cyrillic || 1) > 0.3;
  }
  if (wantJa) {
    /* 日语：得真的有假名。纯汉字的中文页面不算日语 ——
       中文里也常用汉字，光看「汉字占主导」会把中文页面误判成日文。 */
    if (kana > 0.05) return true;
    /* 没有假名时，只有 <html lang="ja"> 能说明它是日文 */
    return hl.startsWith('ja');
  }
  if (wantKo) {
    if (hangul > 0.1) return true;
    return false;
  }
  if (wantEn) {
    return latin > 0.5 && cjk < 0.1;
  }
  if (wantCyr) {
    return cyrillic > 0.4;
  }

  /* 目标语言认不出来时，退一步：最 dominant 的书写系统是不是「像是目标语言的」 */
  return top.ratio > 0.5 && top.script === scriptOfLang(target);
}
