const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const WIDTH = 1080;
const HEIGHT = 1080;
const FPS = 30;
const CLIP_DURATION = 3;
const TRANSITION_DURATION = 0.6;
const WATERMARK_TEXT = "MasterDXF.com";
const TRANSITIONS = ["circleopen", "fade", "wiperight", "diagtl"];
const TMP_DIR = "tmp_video_build";

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
  });
}

function buildFilterComplex(imageCount) {
  const filters = [];
  const clipFrames = Math.round((CLIP_DURATION + TRANSITION_DURATION) * FPS);

  for (let i = 0; i < imageCount; i++) {
    const zoomIn = i % 2 === 0;
    const zoomExpr = zoomIn ? `min(zoom+0.0015,1.2)` : `if(eq(on,0),1.2,max(zoom-0.0015,1.0))`;
    filters.push(
      `[${i}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},` +
      `zoompan=z='${zoomExpr}':d=${clipFrames}:s=${WIDTH}x${HEIGHT}:fps=${FPS},` +
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
    `[vfinal]drawtext=text='${WATERMARK_TEXT}':fontsize=34:fontcolor=white:` +
    `box=1:boxcolor=black@0.35:boxborderw=10:` +
    `x=(w-text_w)/2:y=h-th-40[vout]`
  );

  return filters.join(";\n");
}

async function main() {
  const data = JSON.parse(fs.readFileSync('data/latest-output.json', 'utf8'));
  const { images, music_url } = data;

  if (!images || images.length === 0) throw new Error('لا توجد صور بـ latest-output.json');

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const localImages = [];
  for (let i = 0; i < images.length; i++) {
    const dest = path.join(TMP_DIR, `img${i}.jpg`);
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

  const cmd = [
    'ffmpeg -y',
    imageInputs,
    `-i "${localMusic}"`,
    `-filter_complex "${filterComplex}"`,
    `-map "[vout]"`,
    `-map ${localImages.length}:a`,
    `-af "volume=0.8"`,
    `-c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 128k`,
    `-shortest`,
    `"${outputPath}"`
  ].join(' ');

  console.log('🎬 جارِ بناء الفيديو...');
  execSync(cmd, { stdio: 'inherit' });
  console.log(`✅ تم إنشاء الفيديو: ${outputPath}`);

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

main().catch(err => {
  console.error('❌ خطأ:', err.message);
  process.exit(1);
});
