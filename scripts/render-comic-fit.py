import sys, os, re
from PIL import Image, ImageDraw, ImageFont

W, H = 600, 800

def font(size):
    for name in ("C:/Windows/Fonts/msyh.ttc","C:/Windows/Fonts/msyhbd.ttc","C:/Windows/Fonts/simhei.ttf"):
        if os.path.exists(name):
            try: return ImageFont.truetype(name, size)
            except Exception: pass
    return ImageFont.load_default()

def est_width(text, size):
    units = 0
    for ch in text:
        c = ord(ch)
        if c < 0x41: continue
        if 0x4e00 <= c <= 0x9fff: units += 1
        elif 0x3040 <= c <= 0x30ff: units += 1
        elif 0xac00 <= c <= 0xd7af: units += 1
        else: units += 0.55
    return units * size

def fit_text(text, bw, bh, min_font=10, max_font=34, lh=1.22):
    src = (text or "").strip()
    if not src: return min_font, [""], False
    bw = max(1, bw); bh = max(1, bh)
    max_lines = max(1, int(bh // (min_font * lh)))
    size = min(max_font, max(min_font, int(round(bh * 0.72))))
    def lines_for(sz):
        per = max(1, int(bw // sz)); out=[]; cur=""; units=0
        for word in re.findall(r'\S+\s*|\s+', src):
            wu = est_width(word, 1)
            if units + wu > per and cur:
                out.append(cur.rstrip()); cur=""; units=0
            if wu > per:
                piece=""; pu=0
                for ch in word:
                    cu = est_width(ch, 1)
                    if pu + cu > per and piece:
                        out.append(piece); piece=""; pu=0
                    piece += ch; pu += cu
                cur = piece; units = pu
            else:
                cur += word; units += wu
        if cur.strip(): out.append(cur.rstrip())
        return out or [""]
    lines = lines_for(size); shrunk=False
    while size > min_font and (len(lines) > max_lines or sum(est_width(l,size) for l in lines) > bw*1.02):
        size -= 1; lines = lines_for(size); shrunk=True
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[max_lines-1]
        lines[max_lines-1] = (last[:-1] + "…") if len(last) > 1 else last
        shrunk = True
    return size, lines, shrunk

def readable_color(bg):
    lum = (0.299*bg[0] + 0.587*bg[1] + 0.114*bg[2]) / 255
    return (17,17,17) if lum > 0.55 else (255,255,255)

def adaptive_pad(x1,y1,x2,y2, W, H):
    w = x2-x1; h = y2-y1
    return int(min(max(w*0.1,4),24)), int(min(max(h*0.5,8),44))

def make_page():
    img = Image.new("RGB", (W,H), (232,228,220))
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y/H; v = int(242 - t*26)
        d.line([(0,y),(W,y)], fill=(v, v-4, v-12))
    d.ellipse([120,90,480,270], fill=(255,255,255), outline=(34,34,34), width=3)
    d.text((300,150), "HELLO THERE", font=font(34), fill=(17,17,17), anchor="mm")
    d.text((300,195), "HOW ARE YOU", font=font(30), fill=(17,17,17), anchor="mm")
    d.ellipse([100,340,500,500], fill=(255,255,255), outline=(34,34,34), width=3)
    d.text((300,415), "I AM FINE", font=font(32), fill=(17,17,17), anchor="mm")
    return img

def erase_region(img, x1,y1,x2,y2):
    """用周围底色填掉框里的内容（简化版：直接填中位背景色）"""
    px = img.load()
    samples = []
    band = max(2, int(min(x2-x1, y2-y1)*0.12))
    def push(x,y):
        if 0 <= x < W and 0 <= y < H:
            samples.append(px[x,y])
    for x in range(x1,x2):
        for d in range(band):
            push(x, y1-1-d); push(x, y2+d)
    for y in range(y1,y2):
        for d in range(band):
            push(x1-1-d, y); push(x2+d, y)
    if not samples:
        for y in range(y1,y2):
            for x in range(x1,x2):
                if 0<=x<W and 0<=y<H: samples.append(px[x,y])
    if not samples: return (255,255,255)
    r = sorted(s[0] for s in samples)[len(samples)//2]
    g = sorted(s[1] for s in samples)[len(samples)//2]
    b = sorted(s[2] for s in samples)[len(samples)//2]
    for y in range(y1,y2):
        for x in range(x1,x2):
            if 0<=x<W and 0<=y<H: px[x,y] = (r,g,b)
    return (r,g,b)

def main():
    out_dir = sys.argv[1] if len(sys.argv)>1 else "."
    os.makedirs(out_dir, exist_ok=True)
    page = make_page()
    items = [((196,132,404,170), "你好啊，很高兴认识你"),
             ((206,176,394,212), "你最近过得怎么样"),
             ((222,396,378,434), "我挺好的")]
    d = ImageDraw.Draw(page)
    for (x1,y1,x2,y2), zh in items:
        px_, py_ = adaptive_pad(x1,y1,x2,y2, W, H)
        rx1 = max(0, x1-px_); ry1 = max(0, y1-py_)
        rx2 = min(W, x2+px_); ry2 = min(H, y2+py_)
        # 擦除（范围 = 加了余量后的框）
        bg = erase_region(page, rx1, ry1, rx2, ry2)
        # 排版（用同一块区域）
        w = max(20, rx2-rx1); h = max(14, ry2-ry1)
        size, lines, shrunk = fit_text(zh, w, h)
        f = font(size)
        total = len(lines)*size*1.22
        ty = ry1 + max(0,(h-total)/2)
        for line in lines:
            d.text(((rx1+rx2)/2, ty + size/2), line, font=f, fill=readable_color(bg), anchor="mm")
            ty += size*1.22
        print(f"  {zh!r} 擦除区({rx1},{ry1})-({rx2},{ry2}) 字号{size} 行数{len(lines)} bg={bg} 画在x={(rx1+rx2)//2} y={int(ry1+max(0,(h-total)/2))}")
    page.save(os.path.join(out_dir, "comic-fitted.png"))
    print("输出:", os.path.abspath(out_dir))

main()