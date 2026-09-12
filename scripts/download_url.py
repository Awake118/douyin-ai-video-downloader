#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""直链下载器 —— 配合浏览器 F12 抓到的抖音视频/图片直链使用。

抖音在 2026 年对无 Cookie 的程序化访问全面启用了 JS-VMP 反爬 + 验证码中间页，
所以"给个分享链接自动解析"这条路走不通。可靠做法是：
让已经通过风控的浏览器自己把直链交出来（F12 → Network → 筛选 media），
再用本脚本下载（带正确的 Referer / UA，避免 CDN 403）。

用法：
    ./download_url.py "https://v3-web.douyinvod.com/....mp4"
    ./download_url.py "URL1" "URL2" -o ./downloads --name 视频标题
    ./download_url.py --from-curl curl.txt          # 直接粘 DevTools 的 "Copy as cURL"
    ./download_url.py --from-curl curl.txt -o ./downloads
"""

import argparse
import os
import re
import sys

import requests

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36")

DEFAULT_HEADERS = {
    "User-Agent": UA,
    "Referer": "https://www.douyin.com/",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
}


def parse_curl_text(text):
    """从 DevTools 的 'Copy as cURL' 文本里抠出 URL 和请求头。"""
    urls = re.findall(r"curl\s+(?:-[A-Za-z]+\s+)*['\"](https?://[^'\"]+)['\"]", text)
    if not urls:
        urls = re.findall(r"['\"](https?://[^'\"]+\.(?:mp4|jpe?g|png|webp|heic)[^'\"]*)['\"]", text)
    if not urls:
        urls = re.findall(r"https?://[^\s'\"<>]+", text)

    headers = {}
    for name, value in re.findall(r"-H\s+['\"]([^:'\"]+):\s*([^'\"]*)['\"]", text):
        key = name.strip()
        if key.lower() in ("host", "content-length", "accept-encoding", "connection"):
            continue
        headers[key] = value.strip()
    return urls, headers


def guess_name(url, index, total):
    path = url.split("?")[0].rstrip("/")
    base = os.path.basename(path)
    if not base or "." not in base:
        base = f"douyin_{index:02d}.mp4"
    if total > 1 and index > 1:
        stem, ext = os.path.splitext(base)
        base = f"{stem}_{index:02d}{ext}"
    return re.sub(r'[\\/:*?"<>|]', "_", base)[:120]


def download(session, url, out_path, headers):
    with session.get(url, headers=headers, stream=True, timeout=60, allow_redirects=True) as r:
        ctype = r.headers.get("Content-Type", "")
        if r.status_code != 200:
            print(f"  ✗ HTTP {r.status_code}：{url[:90]}")
            return False
        if "text/html" in ctype:
            print(f"  ✗ 拿到的是网页而不是媒体文件（链接多半已过期或被 CDN 拒绝）Content-Type={ctype}")
            return False

        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        show_progress = sys.stdout.isatty()
        tmp = out_path + ".part"
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=65536):
                if chunk:
                    f.write(chunk)
                    done += len(chunk)
                    if total and show_progress:
                        pct = done * 100 // total
                        sys.stdout.write(f"\r  ↓ {os.path.basename(out_path)} {pct:3d}% "
                                         f"({done/1048576:.1f}/{total/1048576:.1f} MB)")
                        sys.stdout.flush()
        if show_progress:
            sys.stdout.write("\r" + " " * 78 + "\r")
        os.replace(tmp, out_path)
        size = os.path.getsize(out_path)
        if size == 0:
            os.remove(out_path)
            print("  ✗ 文件是 0 字节，链接无效")
            return False
        print(f"  ✓ {out_path}  ({size/1048576:.2f} MB)")
        return True


def main():
    ap = argparse.ArgumentParser(description="下载抖音视频/图片直链（需浏览器先给直链）")
    ap.add_argument("urls", nargs="*", help="媒体直链，可多个（图集）")
    ap.add_argument("--from-curl", metavar="FILE",
                    help="粘贴 DevTools 'Copy as cURL' 内容保存成的文件，自动提取 URL 与请求头")
    ap.add_argument("-o", "--output-dir", default="./downloads", help="输出目录（默认 ./downloads）")
    ap.add_argument("--name", help="文件名（不带扩展名；多文件时自动加序号）")
    ap.add_argument("--cookie", help="额外的 Cookie 字符串（链接 403 时再试）")
    args = ap.parse_args()

    urls = list(args.urls)
    headers = dict(DEFAULT_HEADERS)

    if args.from_curl:
        if not os.path.isfile(args.from_curl):
            print(f"找不到文件：{args.from_curl}", file=sys.stderr)
            return 2
        with open(args.from_curl, encoding="utf-8", errors="replace") as f:
            text = f.read()
        curl_urls, curl_headers = parse_curl_text(text)
        headers.update(curl_headers)
        urls.extend(u for u in curl_urls if u not in urls)
        if not curl_urls:
            print("没能从 cURL 文本里解析出 URL", file=sys.stderr)
            return 2

    if not urls:
        ap.print_help()
        return 2

    if args.cookie:
        headers["Cookie"] = args.cookie
    headers.pop("Host", None)

    os.makedirs(args.output_dir, exist_ok=True)
    session = requests.Session()
    # CDN 对 Referer 很敏感；这里固定用抖音域，其他站点会自动降级
    print(f"共 {len(urls)} 个链接 → {os.path.abspath(args.output_dir)}")

    ok = 0
    for i, url in enumerate(urls, 1):
        name = args.name
        if name:
            ext = os.path.splitext(url.split("?")[0])[1] or ".mp4"
            name = name if name.endswith(ext) else name + ("" if len(urls) == 1 else f"_{i:02d}") + ext
        else:
            name = guess_name(url, i, len(urls))
        out_path = os.path.join(args.output_dir, name)
        if download(session, url, out_path, headers):
            ok += 1

    print(f"\n完成：成功 {ok} / {len(urls)}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
