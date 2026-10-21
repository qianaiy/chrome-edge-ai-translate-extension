"""
离线视觉验证：漫画擦字 + 译文重绘
------------------------------------------------------------------
不启动任何浏览器。用 Pillow 画一张「漫画页」，再跑一遍扩展里用的
那套擦字算法（这里用 Python 复刻同样的逻辑），把结果存成 PNG 供肉眼检查。

用法：python scripts/render-comic-check.py [输出目录]
"""

import sys
import os

from PIL import Image, ImageDraw, ImageFont

W, H = 600, 800

# 扩展里的几个关键参数（跟 src/core/inpaint.ts 保持一致）
BG_SAMPLE_BAND = 0.12      # 估背景色时取框外一圈的比例
ERASE_SKIP = 0.015         # 和背景差这么小就算底色，不动
ERASE_POW = 0.45          # 混合系数的指数（<1 让边缘擦得更狠）
FEATHER = 0.12             # 边缘羽化比例
ERASE_BASE = 0.7           # 羽化的基准权重（越大擦得越彻底）
PAD_X_RATIO = 0.10
PAD_Y_RATIO = 0.50
PAD_X_MAX = 24
PAD_Y_MAX = 44


def font(size):
    """找一个能用的字体，找不到就用默认的。"""
    for name in (
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/msyhbd.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ):
        if os.path.exists(name):
            try:
                return ImageFont.truetype(name, size)
            except Exception:
                pass
    return ImageFont.load_default()


def make_page():
    """画一张有气泡和英文假文字的漫画页。"""
    img = Image.new("RGB", (W, H), (232, 228, 220))
    d = ImageDraw.Draw(img)

    # 背景渐变，检验擦除后有没有保留
    for y in range(H):
        t = y / H
        v = int(242 - t * 26)
        d.line([(0, y), (W, y)], fill=(v, v - 4, v - 12))

    # 气泡 1
    d.ellipse([120, 90, 480, 270], fill=(255, 255, 255), outline=(34, 34, 34), width=3)
    f1 = font(34)
    d.text((300, 150), "HELLO THERE", font=f1, fill=(17, 17, 17), anchor="mm")
    f2 = font(30)
    d.text((300, 195), "HOW ARE YOU", font=f2, fill=(17, 17, 17), anchor="mm")

    # 气泡 2
    d.ellipse([100, 340, 500, 500], fill=(255, 255, 255), outline=(34, 34, 34), width=3)
    f3 = font(32)
    d.text((300, 415), "I AM FINE", font=f3, fill=(17, 17, 17), anchor="mm")

    return img


def to_pct_box(x1, y1, x2, y2):
    return (x1 / W * 100, y1 / H * 100, x2 / W * 100, y2 / H * 100)


def px_box(box):
    """百分比框 -> 像素框（跟 boxToPixels 一样）"""
    ax1, ay1, ax2, ay2 = box
    return (
        int(round(min(ax1, ax2) / 100 * W)),
        int(round(min(ay1, ay2) / 100 * H)),
        int(round(max(ax1, ax2) / 100 * W)),
        int(round(max(ay1, ay2) / 100 * H)),
    )


def adaptive_pad(box):
    ax1, ay1, ax2, ay2 = box
    w = abs(ax2 - ax1) / 100 * W
    h = abs(ay2 - ay1) / 100 * H
    return (
        int(round(min(max(w * PAD_X_RATIO, 4), PAD_X_MAX))),
        int(round(min(max(h * PAD_Y_RATIO, 6), PAD_Y_MAX))),
    )


def median(vals):
    s = sorted(vals)
    return s[len(s) // 2]


def estimate_background(img, x1, y1, x2, y2):
    px = img.load()
    band = max(2, int(round(min(x2 - x1, y2 - y1) * BG_SAMPLE_BAND)))
    rs, gs, bs = [], [], []

    def push(x, y):
        if 0 <= x < W and 0 <= y < H:
            r, g, b = px[x, y]
            rs.append(r); gs.append(g); bs.append(b)

    for x in range(x1, x2):
        for d in range(band):
            push(x, y1 - 1 - d); push(x, y2 + d)
    for y in range(y1, y2):
        for d in range(band):
            push(x1 - 1 - d, y); push(x2 + d, y)

    if not rs:
        for y in range(y1, y2):
            for x in range(x1, x2):
                r, g, b = px[x, y]
                rs.append(r); gs.append(g); bs.append(b)
    if not rs:
        return (255, 255, 255)
    return (median(rs), median(gs), median(bs))


def erase_box(img, x1, y1, x2, y2, bg):
    px = img.load()
    w, h = x2 - x1, y2 - y1
    if w <= 0 or h <= 0:
        return
    feather = max(1, int(round(min(w, h) * FEATHER)))
    for y in range(y1, y2):
        for x in range(x1, x2):
            if not (0 <= x < W and 0 <= y < H):
                continue
            cr, cg, cb = px[x, y]
            diff = abs(cr - bg[0]) + abs(cg - bg[1]) + abs(cb - bg[2])
            t = min(1, diff / 255)
            if t < ERASE_SKIP:
                continue
            edge = min(x - x1, x2 - 1 - x, y - y1, y2 - 1 - y)
            fw = 1 if edge >= feather else edge / feather
            k = min(1, t ** ERASE_POW) * (ERASE_BASE + (1 - ERASE_BASE) * fw)
            px[x, y] = (
                int(cr + (bg[0] - cr) * k),
                int(cg + (bg[1] - cg) * k),
                int(cb + (bg[2] - cb) * k),
            )


def readable_color(bg):
    lum = (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) / 255
    return "#111111" if lum > 0.55 else "#ffffff"


def dark_count(img):
    return sum(1 for p in img.getdata() if p[0] < 128)


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out_dir, exist_ok=True)

    page = make_page()
    page.save(os.path.join(out_dir, "comic-original.png"))

    # 文字块（模拟模型给的百分比框）。
    # 用文字的真实包围盒，故意偏一点点，模拟模型定位不准。
    raw = [
        ((196, 132, 404, 170), "你好"),      # HELLO THERE
        ((206, 176, 394, 212), "你还好吗"),  # HOW ARE YOU
        ((222, 396, 378, 434), "我很好"),     # I AM FINE
    ]
    boxes = [to_pct_box(*r) for r, _ in raw]
    zh = [t for _, t in raw]

    # 先算所有框的范围和背景色（必须在擦之前全估好）
    rects = []
    for b in boxes:
        x1, y1, x2, y2 = px_box(b)
        pad_x, pad_y = adaptive_pad(b)
        rects.append((
            max(0, x1 - pad_x), max(0, y1 - pad_y),
            min(W, x2 + pad_x), min(H, y2 + pad_y),
        ))

    before = dark_count(page)
    bgs = [estimate_background(page, *r) for r in rects]
    for r, bg in zip(rects, bgs):
        erase_box(page, *r, bg)
    after_erase = dark_count(page)

    # 画译文
    d = ImageDraw.Draw(page)
    for (r, bg, text) in zip(rects, bgs, zh):
        x1, y1, x2, y2 = r
        w = max(20, x2 - x1)
        h = max(14, y2 - y1)
        size = max(11, min(int(round(h * 0.72)), 34))
        f = font(size)
        color = readable_color(bg)
        # 描边
        for ox, oy in ((-2, 0), (2, 0), (0, -2), (0, 2)):
            d.text(((x1 + x2) / 2 + ox, (y1 + y2) / 2 + oy), text,
                   font=f, fill=(0, 0, 0) if color == "#ffffff" else (255, 255, 255), anchor="mm")
        d.text(((x1 + x2) / 2, (y1 + y2) / 2), text, font=f, fill=color, anchor="mm")

    after_draw = dark_count(page)
    page.save(os.path.join(out_dir, "comic-inpainted.png"))

    print("暗像素：擦除前 %d → 擦除后 %d → 画译文后 %d" % (before, after_erase, after_draw))
    print("背景色估计：", bgs)
    print("输出目录：", os.path.abspath(out_dir))


if __name__ == "__main__":
    main()

