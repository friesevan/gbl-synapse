"""Render our small Markdown subset to static, AI-readable HTML; no runtime dependency."""
from pathlib import Path
import html, re
root = Path(__file__).resolve().parents[1]
source = root / 'includes/pro/README.md'
def inline(text):
    text = html.escape(text)
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    return re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', text)
lines = source.read_text().splitlines()
parts, toc = [], []
i = 0
while i < len(lines):
    line = lines[i]
    if not line.strip():
        i += 1
        continue
    if line.startswith('```'):
        code = []
        i += 1
        while i < len(lines) and not lines[i].startswith('```'):
            code.append(lines[i]); i += 1
        parts.append('<pre><code>' + html.escape('\n'.join(code)) + '</code></pre>')
    elif line.startswith('#'):
        level = len(line) - len(line.lstrip('#'))
        text = line[level:].strip()
        anchor = re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')
        parts.append(f'<h{level} id="{anchor}">{inline(text)}</h{level}>')
        if level == 2:
            toc.append(f'<li><a href="#{anchor}">{inline(text)}</a></li>')
    elif line.startswith('|'):
        table = []
        while i < len(lines) and lines[i].startswith('|'):
            table.append([cell.strip() for cell in lines[i].strip('|').split('|')]); i += 1
        headers = ''.join('<th scope="col">'+inline(cell)+'</th>' for cell in table[0])
        rows = ''.join('<tr>'+''.join('<td>'+inline(cell)+'</td>' for cell in row)+'</tr>' for row in table[2:])
        parts.append('<div class="table-scroll"><table><thead><tr>'+headers+'</tr></thead><tbody>'+rows+'</tbody></table></div>')
        continue
    elif line.startswith('- '):
        items = []
        while i < len(lines) and lines[i].startswith('- '):
            items.append('<li>'+inline(lines[i][2:])+'</li>'); i += 1
        parts.append('<ul>'+''.join(items)+'</ul>')
        continue
    else:
        paragraph = [line]
        i += 1
        while i < len(lines) and lines[i].strip() and not lines[i].startswith(('#', '|', '- ', '```')):
            paragraph.append(lines[i]); i += 1
        parts.append('<p>'+inline(' '.join(paragraph))+'</p>')
        continue
    i += 1
page = '''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PvPoke Pro — ranking logic README</title><meta name="description" content="Complete guide to PvPoke Pro ranking generation, weights, battle scenarios, score formulas, consistency, editor adjustments, and moveset comparisons.">
<link rel="stylesheet" href="../familyRanks.css"></head><body><main class="pro-docs">
<nav class="pro-doc-links" aria-label="README navigation"><a href="../../familyRanks.html?app=pro">← Back to PvPoke Pro</a><a href="README.md">Plain Markdown / AI source</a></nav>
'''+parts[0]+'''<p class="hint">Technical reference for the shipped implementation. Source snapshot: f627e89. All content is rendered as ordinary HTML for direct reading by people and AI tools.</p>
<nav class="pro-doc-toc" aria-label="Contents"><h2>Contents</h2><ol>'''+''.join(toc)+'''</ol></nav><article>'''+''.join(parts[1:])+'''</article></main></body></html>
'''
(source.with_suffix('.html')).write_text(page)
