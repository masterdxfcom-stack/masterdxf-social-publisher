```javascript
const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const WIDTH = 1080;
const HEIGHT = 1080;
const FPS = 30;

// ================================
// 🎬 إعدادات الفيديو
// ================================

// أول صورة أطول لأنها أهم جزء لجذب المشاهد
const FIRST_CLIP_DURATION = 3.2;

const CLIP_DURATION = 2.5;
const TRANSITION_DURATION = 0.65;

// مدة ظهور الـ Hook
const HOOK_DURATION = 2.4;

const WATERMARK_TEXT = 'MasterDXF.com';

const BOLD_FONT =
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

const TMP_DIR = 'tmp_video_build';
const HOOK_FILE = path.join(TMP_DIR, 'hook_text.txt');


// ================================
// 📥 تحميل الملفات
// ================================

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {

    const options = {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',

        'x-internal-bot-secret':
          'masterdxf-publisher-9f3k2m',

        'Referer':
          'https://masterdxf.com/'
      }
    };

    https.get(url, options, response => {

      // Redirect
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        downloadFile(
          response.headers.location,
          destPath
        )
          .then(resolve)
          .catch(reject);

        return;
      }

      if (response.statusCode !== 200) {
        reject(
          new Error(
            `فشل التحميل: ${response.statusCode} من ${url}`
          )
        );

        return;
      }

      const file =
        fs.createWriteStream(destPath);

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve();
      });

      file.on('error', err => {

        fs.unlink(destPath, () => {});

        reject(err);
      });

    }).on('error', reject);
  });
}


// ================================
// 📝 تقسيم النص
// ================================

function wrapText(text, maxCharsPerLine = 22) {

  const words =
    text.trim().split(/\s+/);

  const lines = [];

  let currentLine = '';

  for (const word of words) {

    const test =
      currentLine
        ? `${currentLine} ${word}`
        : word;

    if (
      test.length <= maxCharsPerLine
    ) {
      currentLine = test;
    } else {

      if (currentLine) {
        lines.push(currentLine);
      }

      currentLine = word;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.join('\n');
}


// ================================
// 🎥 بناء الفلاتر
// ================================

function buildFilterComplex(imageCount) {

  const filters = [];

  // انتقالات متنوعة
  const transitions = [
    'zoomin',
    'smoothleft',
    'smoothright',
    'circleopen',
    'radial',
    'distance'
  ];

  let cumulativeOffset = 0;

  let previousLabel = '';


  // =========================================
  // 🖼️ معالجة كل صورة
  // =========================================

  for (let i = 0; i < imageCount; i++) {

    const isFirst = i === 0;

    const clipDuration =
      isFirst
        ? FIRST_CLIP_DURATION
        : CLIP_DURATION;

    const frames =
      Math.round(
        (clipDuration + TRANSITION_DURATION) *
        FPS
      );


    // ======================================
    // 🎞️ حركة مختلفة لكل صورة
    // ======================================

    let zoomExpr;
    let xExpr;
    let yExpr;

    switch (i % 6) {

      // 1️⃣ Zoom In
      case 0:

        zoomExpr =
          'min(zoom+0.0018,1.18)';

        xExpr =
          'iw/2-(iw/zoom/2)';

        yExpr =
          'ih/2-(ih/zoom/2)';

        break;


      // 2️⃣ حركة من اليسار
      case 1:

        zoomExpr =
          'min(zoom+0.0012,1.12)';

        xExpr =
          'iw/2-(iw/zoom/2)-on*0.35';

        yExpr =
          'ih/2-(ih/zoom/2)';

        break;


      // 3️⃣ حركة من اليمين
      case 2:

        zoomExpr =
          'min(zoom+0.0012,1.12)';

        xExpr =
          'iw/2-(iw/zoom/2)+on*0.35';

        yExpr =
          'ih/2-(ih/zoom/2)';

        break;


      // 4️⃣ Zoom Out
      case 3:

        zoomExpr =
          'if(eq(on,0),1.18,max(zoom-0.0015,1.0))';

        xExpr =
          'iw/2-(iw/zoom/2)';

        yExpr =
          'ih/2-(ih/zoom/2)';

        break;


      // 5️⃣ حركة للأسفل
      case 4:

        zoomExpr =
          'min(zoom+0.0013,1.14)';

        xExpr =
          'iw/2-(iw/zoom/2)';

        yExpr =
          'ih/2-(ih/zoom/2)+on*0.25';

        break;


      // 6️⃣ حركة للأعلى
      default:

        zoomExpr =
          'min(zoom+0.0013,1.14)';

        xExpr =
          'iw/2-(iw/zoom/2)';

        yExpr =
          'ih/2-(ih/zoom/2)-on*0.25';

        break;
    }


    // ======================================
    // 🖼️ تجهيز الصورة
    // ======================================

    filters.push(

      `[${i}:v]` +

      `scale=3240:3240:` +
      `force_original_aspect_ratio=increase,` +

      `crop=3240:3240,` +

      `zoompan=` +

      `z='${zoomExpr}':` +

      `x='${xExpr}':` +

      `y='${yExpr}':` +

      `d=${frames}:` +

      `s=${WIDTH}x${HEIGHT}:` +

      `fps=${FPS},` +

      `format=yuv420p,` +

      `setsar=1,` +

      `fade=t=in:st=0:d=0.12,` +

      `fade=t=out:` +

      `st=${Math.max(
        0,
        clipDuration +
        TRANSITION_DURATION -
        0.12
      ).toFixed(2)}:` +

      `d=0.12` +

      `[v${i}]`
    );
  }


  // =========================================
  // 🎬 الانتقالات السينمائية
  // =========================================

  if (imageCount > 0) {

    previousLabel = 'v0';

    cumulativeOffset =
      FIRST_CLIP_DURATION;


    for (let i = 1; i < imageCount; i++) {

      const transition =
        transitions[
          (i - 1) %
          transitions.length
        ];

      const outLabel =
        i === imageCount - 1
          ? 'vmerged'
          : `vx${i}`;


      filters.push(

        `[${previousLabel}][v${i}]` +

        `xfade=` +

        `transition=${transition}:` +

        `duration=${TRANSITION_DURATION}:` +

        `offset=${cumulativeOffset.toFixed(2)}` +

        `[${outLabel}]`
      );


      previousLabel = outLabel;

      cumulativeOffset +=
        CLIP_DURATION;
    }
  }


  // صورة واحدة فقط
  if (imageCount === 1) {

    filters.push(
      `[v0]null[vmerged]`
    );
  }


  // =========================================
  // 🏷️ Watermark
  // =========================================

  filters.push(

    `[vmerged]drawtext=` +

    `fontfile='${BOLD_FONT}':` +

    `text='${WATERMARK_TEXT}':` +

    `fontsize=34:` +

    `fontcolor=white@0.92:` +

    `borderw=2:` +

    `bordercolor=black@0.8:` +

    `box=1:` +

    `boxcolor=black@0.65:` +

    `boxborderw=12:` +

    `x=(w-text_w)/2:` +

    `y=h-text_h-38` +

    `[vwatermark]`
  );


  // =========================================
  // 🚀 HOOK
  // =========================================

  const hookAlpha =

    `if(lt(t,0.18),t/0.18,` +

    `if(lt(t,${(
      HOOK_DURATION - 0.45
    ).toFixed(2)}),1,` +

    `if(lt(t,${HOOK_DURATION}),` +

    `(${HOOK_DURATION}-t)/0.45,0)))`;


  // حركة دخول النص من الأعلى
  const hookY =

    `if(lt(t,0.35),` +

    `-text_h+((h/2+text_h)*t/0.35),` +

    `(h-text_h)/2)`;


  filters.push(

    `[vwatermark]drawtext=` +

    `fontfile='${BOLD_FONT}':` +

    `textfile='${HOOK_FILE}':` +

    `fontsize=60:` +

    `fontcolor=white:` +

    `borderw=5:` +

    `bordercolor=black:` +

    `box=1:` +

    `boxcolor=black@0.78:` +

    `boxborderw=22:` +

    `line_spacing=14:` +

    `x=(w-text_w)/2:` +

    `y='${hookY}':` +

    `alpha='${hookAlpha}'` +

    `[vout]`
  );


  return filters.join(';\n');
}


// ================================
// 🚀 MAIN
// ================================

async function main() {

  const data = JSON.parse(

    fs.readFileSync(
      'data/latest-output.json',
      'utf8'
    )
  );


  const {
    images,
    music_url,
    hook_text
  } = data;


  if (
    !images ||
    images.length === 0
  ) {

    throw new Error(
      'لا توجد صور في latest-output.json'
    );
  }


  if (!music_url) {

    throw new Error(
      'لا يوجد music_url في latest-output.json'
    );
  }


  fs.mkdirSync(
    TMP_DIR,
    {
      recursive: true
    }
  );


  // ======================================
  // 📝 إنشاء Hook
  // ======================================

  fs.writeFileSync(

    HOOK_FILE,

    wrapText(
      hook_text ||
      'New DXF Design!',
      22
    )
  );


  // ======================================
  // 📥 تحميل الصور
  // ======================================

  const localImages = [];


  for (
    let i = 0;
    i < images.length;
    i++
  ) {

    let url;

    try {

      url =
        new URL(images[i]);

    } catch {

      throw new Error(
        `رابط الصورة غير صالح: ${images[i]}`
      );
    }


    let ext =
      path.extname(
        url.pathname
      );


    if (
      !ext ||
      ext.length > 5
    ) {

      ext = '.jpg';
    }


    const dest =
      path.join(
        TMP_DIR,
        `img${i}${ext}`
      );


    await downloadFile(
      images[i],
      dest
    );


    localImages.push(dest);


    console.log(
      `✅ تم تحميل الصورة ${i + 1}/${images.length}`
    );
  }


  // ======================================
  // 🎵 تحميل الموسيقى
  // ======================================

  const localMusic =
    path.join(
      TMP_DIR,
      'music.mp3'
    );


  await downloadFile(
    music_url,
    localMusic
  );


  console.log(
    '✅ تم تحميل الموسيقى'
  );


  // ======================================
  // 🎥 إنشاء Filter Complex
  // ======================================

  const filterComplex =
    buildFilterComplex(
      localImages.length
    );


  // ======================================
  // FFmpeg Arguments
  // ======================================

  const args = ['-y'];


  // الصور
  for (
    const image of localImages
  ) {

    args.push(
      '-loop',
      '1',
      '-i',
      image
    );
  }


  // الموسيقى
  args.push(
    '-i',
    localMusic
  );


  // ======================================
  // ⏱️ مدة الفيديو
  // ======================================

  const totalDuration =

    FIRST_CLIP_DURATION +

    (localImages.length - 1) *
      CLIP_DURATION +

    0.1;


  const outputPath =
    'data/latest-video.mp4';


  // ======================================
  // 🎬 FFmpeg
  // ======================================

  args.push(

    '-filter_complex',
    filterComplex,

    '-map',
    '[vout]',

    '-map',
    `${localImages.length}:a?`,

    '-t',
    totalDuration.toFixed(2),


    // ============================
    // VIDEO
    // ============================

    '-c:v',
    'libx264',

    '-preset',
    'slow',

    '-crf',
    '16',

    '-profile:v',
    'high',

    '-level',
    '4.2',

    '-pix_fmt',
    'yuv420p',


    // ============================
    // AUDIO
    // ============================

    '-c:a',
    'aac',

    '-b:a',
    '192k',

    '-af',
    'volume=0.85',


    // ============================
    // WEB OPTIMIZATION
    // ============================

    '-movflags',
    '+faststart',


    outputPath
  );


  console.log(
    '🎬 جارِ إنشاء الفيديو الاحترافي...'
  );


  execFileSync(
    'ffmpeg',
    args,
    {
      stdio: 'inherit',
      maxBuffer:
        1024 * 1024 * 50
    }
  );


  console.log(
    `✅ تم إنشاء الفيديو: ${outputPath}`
  );


  // ======================================
  // 🧹 تنظيف الملفات المؤقتة
  // ======================================

  fs.rmSync(
    TMP_DIR,
    {
      recursive: true,
      force: true
    }
  );
}


// ================================
// ❌ ERROR HANDLING
// ================================

main().catch(err => {

  console.error(
    '❌ خطأ:',
    err.message
  );

  process.exit(1);
});
```
