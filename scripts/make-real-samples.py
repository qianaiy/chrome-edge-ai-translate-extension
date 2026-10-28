#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成「有权处理」的真实版式漫画样本 + 真值清单。

为什么要自己画：任务要求真实样本不得把正确坐标直接喂给模型，所以必须有
独立的真值来源。这些图完全由本仓库生成（无第三方版权），版式按真实漫画的
难点设计：竖排、爆炸气泡、网点/渐变背景、拟声词、宽幅条漫。

产物：
  artifacts/real-samples/*.png        样本图
  artifacts/real-samples/manifest.json 真值（气泡框、文字框、原文）

真值只用于打分，绝不发给模型。
"""

import json
import math
import os

from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join("artifacts", "real-samples")
os.makedirs(OUT, exist_ok=True)

JP_FONT = "C:/Windows/Fonts/msgothic.ttc"
KR_FONT = "C:/Windows/Fonts/malgun.ttf"
CN_FONT = "C:/Windows/Fonts/msyh.ttc"

ITEMS = []


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def text_bbox(draw, xy, text, f):
    """精确量出这段文字的墨迹外框（PIL 的 anchor 默认左上）。"""
    x, y = xy
    box = draw.textbbox((x, y), text, font=f)
    return [int(box[0]), int(box[1]), int(box[2]), int(box[3])]


def draw_vertical(draw, cx, top, text, f, fill="black", spacing=1.0):
    """竖排：逐字向下排。返回墨迹外框。"""
    step = int(f.size * spacing)
    ys = []
    for i, ch in enumerate(text):
        w = draw.textlength(ch, font=f)
        draw.text((cx - w / 2, top + i * step), ch, font=f, fill=fill)
        ys.append((top + i * step, top + i * step + f.size))
    left = cx - f.size * 0.5
    return [int(left), int(ys[0][0]), int(cx + f.size * 0.5), int(ys[-1][1])]


def screentone(draw, w, h, base=(242, 242, 238), dot=(214, 214, 210), step=5, r=1):
    draw.rectangle([0, 0, w, h], fill=base)
    for y in range(0, h, step):
        for x in range(0, w, step):
            draw.ellipse([x, y, x + r, y + r], fill=dot)


def ellipse_bubble(draw, box, fill=(255, 255, 255), outline=(17, 17, 17), width=4):
    draw.ellipse(box, fill=fill, outline=outline, width=width)


def rounded_bubble(draw, box, radius=18, fill=(255, 255, 255), outline=(17, 17, 17), width=4):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def burst_polygon(cx, cy, r_out, r_in, spikes=14, rotation=0.0):
    pts = []
    for i in range(spikes * 2):
        ang = rotation + math.pi * i / spikes
        r = r_out if i % 2 == 0 else r_in
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    return pts


def pct(rect, w, h):
    return [
        round(rect[0] / w * 100, 2),
        round(rect[1] / h * 100, 2),
        round(rect[2] / w * 100, 2),
        round(rect[3] / h * 100, 2),
    ]


# ---------------------------------------------------------------- 样本 A：日式竖排页
def sample_jp_vertical():
    W, H = 800, 1200
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    screentone(d, W, H)

    items = []

    # 旁白框（贴着左上角，模拟真实漫画的「框外叙述」）
    nb = [30, 24, 330, 110]
    d.rectangle(nb, fill=(255, 255, 255), outline=(17, 17, 17), width=3)
    f = font(JP_FONT, 26)
    d.text((nb[0] + 14, nb[1] + 16), "学校の屋上にて", font=f, fill="black")
    d.text((nb[0] + 14, nb[1] + 52), "放課後のことだった。", font=f, fill="black")
    txt = text_bbox(d, (nb[0] + 14, nb[1] + 14), "学校の屋上にて", f)
    txt2 = text_bbox(d, (nb[0] + 14, nb[1] + 50), "放課後のことだった。", f)
    items.append({
        "id": "jp-v1", "kind": "narration",
        "bubble": pct(nb, W, H),
        "text": pct([min(txt[0], txt2[0]), min(txt[1], txt2[1]),
                     max(txt[2], txt2[2]), max(txt[3], txt2[3])], W, H),
        "source": "学校の屋上にて 放課後のことだった。",
    })

    # 椭圆气泡 + 竖排
    e1 = [470, 120, 700, 420]
    ellipse_bubble(d, e1)
    f1 = font(JP_FONT, 30)
    body1 = "もう帰ろうか"
    tb1 = draw_vertical(d, (e1[0] + e1[2]) / 2 + 30, e1[1] + 40, body1, f1)
    items.append({
        "id": "jp-v2", "kind": "bubble-vertical",
        "bubble": pct(e1, W, H), "text": pct(tb1, W, H), "source": body1,
    })

    # 椭圆气泡 + 两列竖排（真实漫画里长句会分列）
    e2 = [120, 480, 430, 780]
    ellipse_bubble(d, e2)
    f2 = font(JP_FONT, 26)
    col = "でも、まだ言えてないことがある"
    half = len(col) // 2
    tb2a = draw_vertical(d, e2[2] - 60, e2[1] + 45, col[:half], f2)
    tb2b = draw_vertical(d, e2[2] - 100, e2[1] + 45, col[half:], f2)
    tb2 = [min(tb2a[0], tb2b[0]), min(tb2a[1], tb2b[1]), max(tb2a[2], tb2b[2]), max(tb2a[3], tb2b[3])]
    items.append({
        "id": "jp-v3", "kind": "bubble-vertical-2col",
        "bubble": pct(e2, W, H), "text": pct(tb2, W, H), "source": col,
    })

    # 复杂背景上的气泡：压在深色网点块上
    d.rectangle([40, 860, 420, 1140], fill=(60, 62, 74))
    for y in range(860, 1140, 6):
        for x in range(40, 420, 6):
            d.point((x, y), fill=(92, 96, 110))
    e3 = [80, 880, 400, 1120]
    ellipse_bubble(d, e3)
    f3 = font(JP_FONT, 24)
    body3 = "ここで待ってる"
    tb3 = draw_vertical(d, (e3[0] + e3[2]) / 2 + 24, e3[1] + 30, body3, f3)
    items.append({
        "id": "jp-v4", "kind": "bubble-on-dark",
        "bubble": pct(e3, W, H), "text": pct(tb3, W, H), "source": body3,
    })

    # 拟声词（无气泡，直接贴在画面上）
    f4 = font(JP_FONT, 54)
    tb4 = text_bbox(d, (500, 900), "ザワ…", f4)
    d.text((500, 900), "ザワ…", font=f4, fill=(30, 30, 30))
    items.append({
        "id": "jp-v5", "kind": "sfx",
        "bubble": None, "text": pct(tb4, W, H), "source": "ザワ…",
    })

    return im, items


# ---------------------------------------------------------------- 样本 B：爆炸气泡 + 渐变
def sample_jp_burst():
    W, H = 800, 1000
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=(int(238 - 40 * t), int(242 - 30 * t), int(250 - 20 * t)))

    items = []

    # 爆炸状气泡（锯齿）
    cx, cy, ro, ri = 300, 330, 230, 150
    pts = burst_polygon(cx, cy, ro, ri)
    d.polygon(pts, fill=(255, 255, 255), outline=(17, 17, 17))
    d.line(pts + [pts[0]], fill=(17, 17, 17), width=5)
    f = font(JP_FONT, 34)
    line = "うわああっ！"
    w = d.textlength(line, font=f)
    tb = text_bbox(d, (cx - w / 2, cy - 24), line, f)
    d.text((cx - w / 2, cy - 24), line, font=f, fill="black")
    items.append({
        "id": "jp-b1", "kind": "bubble-burst",
        "bubble": pct([cx - ro, cy - ro, cx + ro, cy + ro], W, H),
        "text": pct(tb, W, H), "source": line,
    })

    # 圆角矩形气泡（对话）
    rb = [460, 520, 740, 650]
    rounded_bubble(d, rb)
    f2 = font(JP_FONT, 24)
    tb2 = text_bbox(d, (rb[0] + 24, rb[1] + 28), "本当に行くの？", f2)
    d.text((tb2[0], tb2[1]), "本当に行くの？", font=f2, fill="black")
    tb3 = text_bbox(d, (rb[0] + 24, rb[1] + 66), "危ないよ。", f2)
    d.text((tb3[0], tb3[1]), "危ないよ。", font=f2, fill="black")
    items.append({
        "id": "jp-b2", "kind": "bubble-rounded",
        "bubble": pct(rb, W, H),
        "text": pct([min(tb2[0], tb3[0]), min(tb2[1], tb3[1]), max(tb2[2], tb3[2]), max(tb2[3], tb3[3])], W, H),
        "source": "本当に行くの？ 危ないよ。",
    })

    # 小气泡（短句，字号应自动变大）
    sb = [110, 700, 320, 860]
    ellipse_bubble(d, sb)
    f3 = font(JP_FONT, 40)
    line3 = "行く。"
    w3 = d.textlength(line3, font=f3)
    tb4 = text_bbox(d, ((sb[0] + sb[2]) / 2 - w3 / 2, (sb[1] + sb[3]) / 2 - 22), line3, f3)
    d.text((tb4[0], tb4[1]), line3, font=f3, fill="black")
    items.append({
        "id": "jp-b3", "kind": "bubble-small",
        "bubble": pct(sb, W, H), "text": pct(tb4, W, H), "source": line3,
    })

    return im, items


# ---------------------------------------------------------------- 样本 C：韩式条漫
def sample_kr_strip():
    W, H = 900, 1600
    im = Image.new("RGB", (W, H), (250, 246, 238))
    d = ImageDraw.Draw(im)
    # 背景大色块，模拟条漫的平涂背景
    d.rectangle([0, 0, W, 420], fill=(232, 240, 250))
    d.rectangle([0, 980, W, H], fill=(246, 232, 236))

    items = []

    rb1 = [90, 120, 780, 250]
    rounded_bubble(d, rb1, radius=26)
    f = font(KR_FONT, 28)
    tb1 = text_bbox(d, (rb1[0] + 30, rb1[1] + 24), "이게 진짜라고?", f)
    d.text(tb1[:2], "이게 진짜라고?", font=f, fill="black")
    tb2 = text_bbox(d, (rb1[0] + 30, rb1[1] + 72), "말도 안 돼.", f)
    d.text(tb2[:2], "말도 안 돼.", font=f, fill="black")
    items.append({
        "id": "kr-1", "kind": "bubble-rounded-wide",
        "bubble": pct(rb1, W, H),
        "text": pct([min(tb1[0], tb2[0]), min(tb1[1], tb2[1]), max(tb1[2], tb2[2]), max(tb1[3], tb2[3])], W, H),
        "source": "이게 진짜라고? 말도 안 돼.",
    })

    # 不规则气泡：手绘感的多边形
    poly = [(130, 560), (300, 520), (520, 540), (600, 650), (520, 760), (280, 780), (120, 700)]
    d.polygon(poly, fill=(255, 255, 255), outline=(20, 20, 20))
    d.line(poly + [poly[0]], fill=(20, 20, 20), width=4)
    f2 = font(KR_FONT, 26)
    tb3 = text_bbox(d, (200, 620), "그럼 지금 가자.", f2)
    d.text(tb3[:2], "그럼 지금 가자.", font=f2, fill="black")
    tb4 = text_bbox(d, (200, 668), "시간 없어.", f2)
    d.text(tb4[:2], "시간 없어.", font=f2, fill="black")
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    items.append({
        "id": "kr-2", "kind": "bubble-irregular",
        "bubble": pct([min(xs), min(ys), max(xs), max(ys)], W, H),
        "text": pct([min(tb3[0], tb4[0]), min(tb3[1], tb4[1]), max(tb3[2], tb4[2]), max(tb3[3], tb4[3])], W, H),
        "source": "그럼 지금 가자. 시간 없어.",
    })

    # 长段对白（最容易溢出的那种）
    rb3 = [110, 1060, 800, 1300]
    rounded_bubble(d, rb3, radius=20)
    f3 = font(KR_FONT, 24)
    lines = ["내가 이 일을 시작한 건", "그날 밤 때문이었어.", "아무도 믿지 않았지만,", "난 끝까지 갈 거야."]
    tbs = []
    for i, ln in enumerate(lines):
        b = text_bbox(d, (rb3[0] + 28, rb3[1] + 22 + i * 40), ln, f3)
        d.text(b[:2], ln, font=f3, fill="black")
        tbs.append(b)
    items.append({
        "id": "kr-3", "kind": "bubble-long-text",
        "bubble": pct(rb3, W, H),
        "text": pct([min(b[0] for b in tbs), min(b[1] for b in tbs),
                     max(b[2] for b in tbs), max(b[3] for b in tbs)], W, H),
        "source": " ".join(lines),
    })

    return im, items


def main():
    manifest = {"note": "本仓库自建样本，无第三方版权；真值只用于打分，不发给模型。", "samples": []}

    for name, fn in [
        ("jp-vertical", sample_jp_vertical),
        ("jp-burst", sample_jp_burst),
        ("kr-strip", sample_kr_strip),
    ]:
        im, items = fn()
        path = os.path.join(OUT, name + ".png")
        im.save(path)
        manifest["samples"].append({
            "name": name,
            "file": name + ".png",
            "width": im.width,
            "height": im.height,
            "items": items,
        })
        print(f"✓ {name}.png  {im.width}x{im.height}  {len(items)} 个文字区")

    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    print("✓ manifest.json")


if __name__ == "__main__":
    main()
