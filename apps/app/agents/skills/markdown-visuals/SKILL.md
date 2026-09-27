---
name: markdown-visuals
description: Create visual replies in Work conversations using html-preview diagram cards and Markdown image cards for screenshots, generated images, and other workspace images.
---

# Visual Markdown replies

The Work chat renders ordinary Markdown around two visual formats. Use a visual when it makes a structure, result, or comparison easier to understand. Keep the explanation in Markdown text outside the visual so the answer remains readable without the card.

## HTML preview card

Put a complete, closed `html-preview` fenced code block between Markdown paragraphs. It becomes a preview card after the closing fence arrives. Write self-contained, static HTML with inline CSS and SVG; SVG is useful for precise boxes, arrows, and labels. The card supplies its own preview, enlarge, source, download, and add-to-conversation controls.

````markdown
请求进入运行时，再交给工具层处理：

```html-preview
<svg viewBox="0 0 680 160" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="消息处理流程">
  <rect x="12" y="44" width="170" height="72" rx="14" fill="#eaf4f0" />
  <text x="97" y="86" text-anchor="middle" fill="#23483b" font-size="20">消息</text>
  <path d="M195 80h65m-12-10 12 10-12 10" fill="none" stroke="#628577" stroke-width="3" />
  <rect x="273" y="44" width="170" height="72" rx="14" fill="#eaf4f0" />
  <text x="358" y="86" text-anchor="middle" fill="#23483b" font-size="20">运行时</text>
  <path d="M456 80h65m-12-10 12 10-12 10" fill="none" stroke="#628577" stroke-width="3" />
  <rect x="534" y="44" width="134" height="72" rx="14" fill="#eaf4f0" />
  <text x="601" y="86" text-anchor="middle" fill="#23483b" font-size="20">工具</text>
</svg>
```

工具执行后，结果回到对话。
````

The preview iframe is static: scripts, external resources, network requests, and interactive controls are unavailable. Put any necessary labels and content directly in the HTML/SVG. Use a responsive SVG `viewBox` and legible text; the inline card is about 420 px tall.

## Image card

Use normal Markdown image syntax. For a local image, first create or verify a PNG, JPEG, GIF, WebP, or AVIF file inside the current Work conversation's directory, then reference its workspace-relative path. Browser screenshots are saved under that conversation's `images/` directory; use the path returned by the screenshot tool.

```markdown
![浏览器页面截图](images/browser-home.png) ![第二张截图](images/browser-details.png)
```

Images render at up to 200 px wide and retain their aspect ratio. Several images can share a line. The user can click one for full-screen preview or use the card control to open it in the right sidebar. Use descriptive alt text and refer only to files that actually exist. HTTPS image URLs also work when a local file is unnecessary.
