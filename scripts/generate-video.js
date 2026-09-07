const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const WIDTH = 1080;
const HEIGHT = 1080;
const SUPERSAMPLE = WIDTH * 3;
const FPS = 30;
const CLIP_DURATION = 2.5;
const TRANSITION_DURATION = 0.5;
const WATERMARK_TEXT = "MasterDXF.com";
const TRANSITIONS = ["zoomin", "circleopen", "radial", "distance"];
const HOOK_DURATION = 2.3;
const BOLD_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const TMP_DIR = "tmp_video_build";
const HOOK_FILE = path.join(TMP_DIR, "hook_text.txt");

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'x-internal-bot-secret': 'masterdxf-publisher-9f3k2m',
        'Referer': 'https://masterdxf.com/'
      }
    };
    https.get(url, options, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`فشل التحميل: ${response.statusCode} من ${url}`));
        return;
      }
      const file = fs.createWriteStream(destPath);
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    }).on('error', (err) => { reject(err); });
  });
}

function wrapText(text, maxCharsPerLine) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    if ((currentLine + ' ' + word).trim().length <= maxCharsPerLine) {
      currentLine = (currentLine + ' ' + word).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.join('\n');
}

function buildFilterComplex(imageCount) {
  const filters = [];
  const clipFrames = Math.round((CLIP_DURATION + TRANSITION_DURATION) * FPS);

  for (let i = 0; i < imageCount; i++) {
    const zoomIn = i % 2 === 0;
    const zoomExpr = zoomIn ? `min(zoom+0.0015,1.2)` : `if(eq(on,0),1.2,max(zoom-0.0015,1.0))`;
    filters.push(
      `[${i}:v]scale=${SUPERSAMPLE}:${SUPERSAMPLE}:force_original_aspect_ratio=increase,crop=${SUPERSAMPLE}:${SUPERSAMPLE},` +
      `zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${clipFrames}:s=${WIDTH}x${HEIGHT}:fps=${FPS},` +
      `setsar=1[v${i}]`
    );
  }

  let lastLabel = "v0";
  let cumulativeOffset = CLIP_DURATION;
  for (let i = 1; i < imageCount; i++) {
    const transitionName = TRANSITIONS[(i - 1) % TRANSITIONS.length];
    const outLabel = i === imageCount - 1 ? "vfinal" : `vx${i}`;
    filters.push(
      `[${lastLabel}][v${i}]xfade=transition=${transitionName}:duration=${TRANSITION_DURATION}:offset=${cumulativeOffset.toFixed(2)}[${outLabel}]`
    );
    lastLabel = outLabel;
    cumulativeOffset += CLIP_DURATION;
  }

  filters.push(
    `[vfinal]drawtext=fontfile='${BOLD_FONT}':text='${WATERMARK_TEXT}':fontsize=38:fontcolor=white:` +
    `borderw=3:bordercolor=black:` +
    `box=1:boxcolor=black@0.75:boxborderw=14:` +
    `x=(w-text_w)/2:y=h-th-40[vwm]`
  );

  const hookAlpha = `if(lt(t,0.3),t/0.3,if(lt(t,${HOOK_DURATION - 0.5}),1,if(lt(t,${HOOK_DURATION}),(${HOOK_DURATION}-t)/0.5,0)))`;
  filters.push(
    `[vwm]drawtext=fontfile='${BOLD_FONT}':textfile='${HOOK_FILE}':fontsize=56:fontcolor=white:` +
    `borderw=4:bordercolor=black:` +
    `box=1:boxcolor=black@0.8:boxborderw=22:line_spacing=12:` +
    `x=(w-text_w)/2:y=(h-text_h)/2:` +
    `alpha='${hookAlpha}'[vout]`
  );

  return filters.join(";\n");
}

async function main() {
  const data = JSON.parse(fs.readFileSync('data/latest-output.json', 'utf8'));
  const { images, music_url, hook_text } = data;

  if (!images || images.length === 0) throw new Error('لا توجد صور بـ latest-output.json');

  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(HOOK_FILE, wrapText(hook_text || 'MasterDXF.com', 26));

  const localImages = [];
  for (let i = 0; i < images.length; i++) {
    const urlExt = path.extname(new URL(images[i]).pathname) || '.jpg';
    const dest = path.join(TMP_DIR, `img${i}${urlExt}`);
    await downloadFile(images[i], dest);
    localImages.push(dest);
    console.log(`✅ تم تحميل الصورة ${i + 1}/${images.length}`);
  }
  const localMusic = path.join(TMP_DIR, 'music.mp3');
  await downloadFile(music_url, localMusic);
  console.log('✅ تم تحميل الموسيقى');

  const filterComplex = buildFilterComplex(localImages.length);
  const imageInputs = localImages.map(f => `-loop 1 -i "${f}"`).join(' ');
  const outputPath = 'data/latest-video.mp4';

  const expectedDuration = CLIP_DURATION + (localImages.length - 1) * CLIP_DURATION;
  const safetyDuration = (expectedDuration + 0.3).toFixed(2);

  const cmd = [
    'ffmpeg -y',
    imageInputs,
    `-i "${localMusic}"`,
    `-filter_complex "${filterComplex}"`,
    `-map "[vout]"`,
    `-map ${localImages.length}:a`,
    `-af "volume=0.8"`,
    `-t ${safetyDuration}`,
    `-c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -c:a aac -b:a 128k`,
    `"${outputPath}"`
  ].join(' ');

  console.log('🎬 جارِ بناء الفيديو بجودة عالية...');
  execSync(cmd, { stdio: 'inherit' });
  console.log(`✅ تم إنشاء الفيديو: ${outputPath}`);

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

main().catch(err => {
  console.error('❌ خطأ:', err.message);
  process.exit(1);
});
