"""Render the code-drawn leaf logo into native desktop/PWA icons. No network."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SCALE = 3
image = Image.new('RGBA', (512 * SCALE, 512 * SCALE), '#667c68')
draw = ImageDraw.Draw(image)

def curve(points):
    result = []
    for i in range(81):
        t = i / 80
        x = (1-t)**3 * points[0][0] + 3*(1-t)**2*t*points[1][0] + 3*(1-t)*t*t*points[2][0] + t**3*points[3][0]
        y = (1-t)**3 * points[0][1] + 3*(1-t)**2*t*points[1][1] + 3*(1-t)*t*t*points[2][1] + t**3*points[3][1]
        result.append((x*SCALE, y*SCALE))
    return result

def leaf(first, second, color):
    draw.polygon(curve(first) + curve(second), fill=color)

draw.line((251*SCALE,388*SCALE,251*SCALE,242*SCALE),fill='#eaf0df',width=16*SCALE)
draw.ellipse((243*SCALE,380*SCALE,259*SCALE,396*SCALE),fill='#eaf0df')
leaf([(251,309),(153,311),(133,253),(137,217)],[(137,217),(195,214),(253,241),(251,309)],'#b6c8a5')
leaf([(253,264),(340,265),(372,208),(368,166)],[(368,166),(307,164),(252,194),(253,264)],'#e2ead2')
leaf([(249,229),(180,187),(178,145),(202,110)],[(202,110),(247,136),(272,179),(249,229)],'#d0deb9')
for size in (192,512):
    image.resize((size,size),Image.Resampling.LANCZOS).save(ROOT/'icons'/f'app-{size}.png')
image.resize((256,256),Image.Resampling.LANCZOS).save(ROOT/'icons'/'app.ico',sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
print('Generated PNG and ICO icons')
