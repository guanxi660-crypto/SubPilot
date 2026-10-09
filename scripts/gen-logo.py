#!/usr/bin/env python3
"""从原始图标重新生成站点 logo 资产（apps/web/public/）。

为什么需要这个脚本：
  站点 logo 不是手绘的，而是从一张位图（VTracer 真彩描摹出的 SVG）**重新上色**来的。
  上色规则本身就是设计决策（见下方 STYLE），改了就得重跑。没有脚本的话，
  下次调色要重新做一遍行/列前景分析才能定位图形与字样分界。

输入：原始 SVG（含 "Subpilot" 字样与深色方底，1254×1254）
输出：
  logo.svg             侧栏 / 移动端顶栏 / 登录页 / favicon 共用（矢量）
  favicon.svg          同内容另存一份，便于浏览器默认探测 /favicon.svg
  favicon.ico          16/32/48 多尺寸，兜底老浏览器
  apple-touch-icon.png 180×180，iOS 主屏

依赖：numpy、pillow（本机隔离环境），以及 Chrome（渲染位图兜底图标）。
  用法：python scripts/gen-logo.py <原始.svg>
"""

import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "apps" / "web" / "public"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

# 原图实测：图形区 y∈[212,726]，字样区 y∈[790,1005]，中间是干净的空带。
WORDMARK_Y = 775
CANVAS = 1254
MIN_DIM = 3.0  # 碎 path 阈值（原图单位）；折算到 16px 下不足 0.04px

NUM = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")

# ============================================================================
# 上色方式（改这里就能换风格）
#   "gradient-tile" —— 底是品牌渐变方块，图形用白色 + 按原图亮度给透明度。
#                      形态与站点原来的 .logo-mark（渐变底 + 白色字形）一致。← 当前采用
#   "ramp"          —— 底是纯色，图形自身按亮度映射到 RAMP 渐变上。
# ============================================================================
STYLE = "gradient-tile"

GRADIENT_FROM = "#7c6cff"  # == 站点 CSS 的 --accent
GRADIENT_TO = "#4cc9f0"  # == 站点 CSS 的 --accent2

# gradient-tile 模式下，白色图形的透明度曲线：
# 原图亮度 <= OP_LO 的给 OP_MIN，>= OP_HI 的给全不透明。
#
# 为什么是这组值：白对渐变亮端（#4cc9f0，L≈177）只有约 1.7:1 对比度，
# 早期用 (55, 130, 0.16) 时云朵左下角（原图深蓝，L≈66）只到 0.16 不透明度，
# 和底色糊成一团白斑。抬高后 L≈66 → 0.72，云朵/飞机的轮廓才立得住。
# 代价是云朵内部的渐变层次被压平 —— 但侧栏只显示 36px，可读性优先。
OP_LO, OP_HI, OP_MIN = 30, 80, 0.45

# ramp 模式用的品牌渐变（按亮度升序）。前两项 == --accent / --accent2。
RAMP = [
    "#0a0722",  # 底：站点暗色系（略带紫的深 navy）
    "#3d2fb0",
    "#6a5aee",
    "#7c6cff",  # == --accent
    "#6f9ef8",  # 紫→青过渡
    "#4cc9f0",  # == --accent2
    "#7ad9f5",
    "#d8ecfc",
    "#ffffff",
]


def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def lum(c):
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def build_lut(stops):
    """把 ramp 展开成 256 项查找表，按亮度索引。"""
    pts = sorted((lum(hex2rgb(c)), hex2rgb(c)) for c in stops)
    lut = np.zeros((256, 3), dtype=np.float64)
    for i in range(256):
        if i <= pts[0][0]:
            lut[i] = pts[0][1]
        elif i >= pts[-1][0]:
            lut[i] = pts[-1][1]
        else:
            for j in range(len(pts) - 1):
                l0, c0 = pts[j]
                l1, c1 = pts[j + 1]
                if l0 <= i <= l1:
                    t = (i - l0) / (l1 - l0) if l1 > l0 else 0.0
                    lut[i] = [c0[k] + (c1[k] - c0[k]) * t for k in range(3)]
                    break
    return lut


def round_d(d, nd=1):
    """坐标降精度。760 单位视口渲染到 36px，1 位小数已远超需要。"""
    return NUM.sub(lambda m: f"{round(float(m.group()), nd):g}", d)


def parse(src):
    """VTracer 的 path 用**局部坐标 + transform=translate(x,y)**，
    所以外接框必须 = 局部 bbox + 偏移，不能只取 d 里的数。"""
    out = []
    for tag in re.findall(r"<path\b[^>]*/>", src):
        d = re.search(r'd="([^"]+)"', tag)
        f = re.search(r'fill="([^"]+)"', tag)
        t = re.search(r'transform="translate\(([-\d.]+),([-\d.]+)\)"', tag)
        if not (d and f and t):
            continue
        nums = [float(x) for x in NUM.findall(d.group(1))]
        xs, ys = nums[0::2], nums[1::2]
        tx, ty = float(t.group(1)), float(t.group(2))
        out.append(
            {
                "d": d.group(1).strip(),
                "fill": f.group(1),
                "tx": tx,
                "ty": ty,
                "x0": min(xs) + tx,
                "x1": max(xs) + tx,
                "y0": min(ys) + ty,
                "y1": max(ys) + ty,
            }
        )
    return out


def build_svg(src_path):
    paths = parse(Path(src_path).read_text(encoding="utf-8"))
    bg = [p for p in paths if p["x1"] - p["x0"] > CANVAS * 0.95 and p["y1"] - p["y0"] > CANVAS * 0.95]
    emblem = [p for p in paths if p not in bg and p["y0"] < WORDMARK_Y and p["y1"] < WORDMARK_Y]
    kept = [p for p in emblem if max(p["x1"] - p["x0"], p["y1"] - p["y0"]) >= MIN_DIM]
    print(f"  path：图形 {len(emblem)} 条 → 剔除碎块后 {len(kept)} 条；字样/背景已丢弃")

    ex0 = min(p["x0"] for p in kept); ex1 = max(p["x1"] for p in kept)
    ey0 = min(p["y0"] for p in kept); ey1 = max(p["y1"] for p in kept)
    cx, cy = (ex0 + ex1) / 2, (ey0 + ey1) / 2
    half = 380  # 正方形边长 = 2*half；图形宽 714，留 ~3% 边距
    vx, vy, vs = round(cx - half), round(cy - half), half * 2

    body = []
    if STYLE == "gradient-tile":
        # 底 = 品牌渐变（135°：左上紫 → 右下青，与站点 .logo-mark 同向），
        # 图形 = 白色 + 按原图亮度给透明度，保住云朵/飞机的明暗层次。
        for p in kept:
            l = lum(hex2rgb(p["fill"]))
            op = float(np.clip((l - OP_LO) / (OP_HI - OP_LO), OP_MIN, 1.0))
            body.append(
                f'<path d="{round_d(p["d"])}" fill="#ffffff" fill-opacity="{op:.2f}"'
                f' transform="translate({round(p["tx"], 1):g},{round(p["ty"], 1):g})"/>'
            )
        back = (
            '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
            f'<stop offset="0" stop-color="{GRADIENT_FROM}"/>'
            f'<stop offset="1" stop-color="{GRADIENT_TO}"/></linearGradient></defs>'
            f'<rect x="{vx}" y="{vy}" width="{vs}" height="{vs}" fill="url(#g)"/>'
        )
    elif STYLE == "ramp":
        lut = build_lut(RAMP)
        for p in kept:
            idx = int(round(lum(hex2rgb(p["fill"]))))
            r, g, b = (int(x) for x in np.clip(lut[idx], 0, 255))
            body.append(
                f'<path d="{round_d(p["d"])}" fill="#{r:02x}{g:02x}{b:02x}"'
                f' transform="translate({round(p["tx"], 1):g},{round(p["ty"], 1):g})"/>'
            )
        back = f'<rect x="{vx}" y="{vy}" width="{vs}" height="{vs}" fill="{RAMP[0]}"/>'
    else:
        raise SystemExit(f"未知 STYLE: {STYLE}")

    return (
        '<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="{vx} {vy} {vs} {vs}" role="img" aria-label="SubPilot X">'
        + back
        + "".join(body)
        + "</svg>"
    )


def render_png(svg_text, size, out):
    with tempfile.TemporaryDirectory() as td:
        f = Path(td) / "l.svg"
        f.write_text(svg_text, encoding="utf-8")
        subprocess.run(
            [
                CHROME, "--headless=new", "--disable-gpu", "--no-proxy-server",
                "--hide-scrollbars", "--force-device-scale-factor=1",
                f"--window-size={size},{size}", f"--screenshot={out}", f.as_uri(),
            ],
            check=True,
            capture_output=True,
        )
    return Image.open(out).convert("RGB")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    svg = build_svg(sys.argv[1])
    PUBLIC.mkdir(parents=True, exist_ok=True)
    (PUBLIC / "logo.svg").write_text(svg, encoding="utf-8")
    (PUBLIC / "favicon.svg").write_text(svg, encoding="utf-8")
    print(f"  logo.svg / favicon.svg  {len(svg.encode()) / 1024:.1f} KB")

    with tempfile.TemporaryDirectory() as td:
        big = render_png(svg, 512, str(Path(td) / "512.png"))
        big.save(PUBLIC / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
        render_png(svg, 180, str(Path(td) / "180.png")).save(PUBLIC / "apple-touch-icon.png")
    print("  favicon.ico (16/32/48) · apple-touch-icon.png (180)")


if __name__ == "__main__":
    main()
