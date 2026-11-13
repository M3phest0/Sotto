import io

p = "src/editor/Editor.tsx"
s = io.open(p, encoding="utf-8").read()
block = io.open("scripts/stats-block.txt", encoding="utf-8").read()

start = s.index("function tasksInRange(")
end = s.index("function SettingsList() {")
s = s[:start] + block + s[end:]
io.open(p, "w", encoding="utf-8").write(s)

css_path = "src/editor/editor.css"
css = io.open(css_path, encoding="utf-8").read()
extra = io.open("scripts/stats-extra.css", encoding="utf-8").read()
if ".seg-group" not in css:
    css = css + extra
io.open(css_path, "w", encoding="utf-8").write(css)

print("spliced stats block and css")
